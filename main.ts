import { LAMPORTS_PER_SOL, runBot } from "./vendor/makefun-bot.ts";
import type { OrderInput } from "./vendor/makefun-bot.ts";

// Filtered first-pullback dip rider on the pump.fun bonding-curve replay.
// The bot watches every curve's trade tape, buys a young coin once after it
// has run up, pulled back and started bouncing again, and exits the whole
// position on a take profit, a stop loss or a maximum hold. Small probe
// round trips keep the trade count on pace when real entries lag. Every
// decision comes from the replay itself: no clock, no environment reads and
// no unseeded randomness anywhere, so two runs agree order for order.

const ENTRY_QUOTE = LAMPORTS_PER_SOL / 20n;
const PROBE_QUOTE = LAMPORTS_PER_SOL / 100n;
const MIN_REAL_QUOTE = 15n * LAMPORTS_PER_SOL;
const PROBE_MIN_REAL_QUOTE = 5n * LAMPORTS_PER_SOL;
const MAX_AGE_SLOTS = 900;
const WINDOW_SLOTS = 2500;
const RUNUP_TIMES = 2;
const DIP_HIGH_BPS = 9200;
const DIP_LOW_BPS = 5000;
const BOUNCE_BPS = 10500;
const FLOW_SLOTS = 30;
const MIN_BUYERS = 5;
const RECENT_TRADES = 6;
const MIN_RECENT_BUYS = 3;
const TAPE_MAX = 300;
const TAKE_PROFIT_NUM = 140n;
const STOP_NUM = 92n;
const MAX_HOLD_SLOTS = 450;
const CURVE_FEE_BPS = 125;
const BUY_SLIPPAGE_BPS = 500;
const SELL_SLIPPAGE_BPS = 3000;
const MAX_OPEN = 5;
const MAX_ORDERS = 16;
const PACE_TARGET = 25;
const PACE_WINDOW_SECONDS = 21600;
const PACE_MIN_ELAPSED_SECONDS = 1800;
const FAILED_BUY_COOLDOWN_SLOTS = 60;
const PROBE_COOLDOWN_SLOTS = 30;

interface TapeTrade {
  slot: number;
  price: number;
  buy: boolean;
  user: string;
  sol: bigint;
}

interface CoinTape {
  created: number;
  trades: TapeTrade[];
}

interface SentKind {
  mint: string;
  side: string;
  kind: string;
}

const tapes = new Map<string, CoinTape>();
const enteredOnce = new Set<string>();
const entrySlot = new Map<string, number>();
const failedBuySlot = new Map<string, number>();
const buyLamports = new Map<string, bigint>();
const roundTripped = new Set<string>();
const probed = new Set<string>();
const sentKind = new Map<string, SentKind>();
let orderCounter = 1;
let probeMint: string | null = null;
let probeWaitingSell = false;
let lastProbeAttemptSlot = -1000000;
let firstBlockTime = 0;
let lastBlockTime = 0;

function tapeFor(mint: string, slot: number): CoinTape {
  let found = tapes.get(mint);
  if (found === undefined) {
    found = { created: slot, trades: [] };
    tapes.set(mint, found);
  }
  return found;
}

function priceOf(virtualQuote: bigint, virtualTokens: bigint): number {
  if (virtualTokens <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualTokens);
}

function liquidValue(tokens: bigint, virtualQuote: bigint, virtualTokens: bigint, realQuote: bigint): bigint {
  if (tokens <= 0n || virtualTokens <= 0n) return 0n;
  let gross = (tokens * virtualQuote) / (virtualTokens + tokens);
  if (gross > realQuote) gross = realQuote;
  return (gross * BigInt(10000 - CURVE_FEE_BPS)) / 10000n;
}

function windowStats(tape: CoinTape, now: number): { high: number; highSlot: number; firstPrice: number; lowAfterHigh: number } | null {
  const start = now - WINDOW_SLOTS;
  let high = 0;
  let highSlot = -1;
  let firstPrice = 0;
  let seen = false;
  for (const trade of tape.trades) {
    if (trade.slot < start) continue;
    if (!seen) {
      firstPrice = trade.price;
      seen = true;
    }
    if (trade.price > high) {
      high = trade.price;
      highSlot = trade.slot;
    }
  }
  if (!seen || high <= 0 || firstPrice <= 0) return null;
  let lowAfterHigh = Number.POSITIVE_INFINITY;
  for (const trade of tape.trades) {
    if (trade.slot > highSlot && trade.slot >= start && trade.price < lowAfterHigh) {
      lowAfterHigh = trade.price;
    }
  }
  return { high, highSlot, firstPrice, lowAfterHigh };
}

function entryReady(mint: string, tape: CoinTape, now: number, realQuote: bigint): boolean {
  if (enteredOnce.has(mint)) return false;
  if (now - tape.created > MAX_AGE_SLOTS) return false;
  if (realQuote < MIN_REAL_QUOTE) return false;
  const lastFail = failedBuySlot.get(mint);
  if (lastFail !== undefined && now - lastFail < FAILED_BUY_COOLDOWN_SLOTS) return false;
  const stats = windowStats(tape, now);
  if (stats === null) return false;
  if (stats.high < stats.firstPrice * RUNUP_TIMES) return false;
  const last = tape.trades[tape.trades.length - 1];
  if (last === undefined) return false;
  const price = last.price;
  if (price * 10000 > stats.high * DIP_HIGH_BPS) return false;
  if (price * 10000 < stats.high * DIP_LOW_BPS) return false;
  if (!Number.isFinite(stats.lowAfterHigh)) return false;
  if (price * 10000 < stats.lowAfterHigh * BOUNCE_BPS) return false;
  let recentBuys = 0;
  const count = tape.trades.length;
  for (let i = count - RECENT_TRADES < 0 ? 0 : count - RECENT_TRADES; i < count; i++) {
    if (tape.trades[i].buy) recentBuys++;
  }
  if (recentBuys < MIN_RECENT_BUYS) return false;
  const buyers = new Set<string>();
  let flow = 0n;
  for (let i = count - 1; i >= 0; i--) {
    const trade = tape.trades[i];
    if (trade.slot < now - FLOW_SLOTS) break;
    if (trade.buy) {
      buyers.add(trade.user);
      flow += trade.sol;
    } else {
      flow -= trade.sol;
    }
  }
  if (buyers.size < MIN_BUYERS) return false;
  if (flow < 0n) return false;
  return true;
}

await runBot({
  onBatch(state, batch) {
    const orders: OrderInput[] = [];
    const now = batch.slot;
    const pendingSell = new Set<string>();
    const pendingBuy = new Set<string>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === "sell") pendingSell.add(pending.order.mint);
      else pendingBuy.add(pending.order.mint);
    }

    for (const fill of batch.fills) {
      const kind = sentKind.get(fill.client_id);
      if (kind !== undefined) sentKind.delete(fill.client_id);
      if (fill.status === "filled") {
        if (fill.side === "buy") {
          const before = buyLamports.get(fill.mint) ?? 0n;
          buyLamports.set(fill.mint, before + BigInt(fill.quote_lamports));
          if (kind !== undefined && kind.kind === "probe") {
            probeWaitingSell = true;
            probed.add(fill.mint);
          } else {
            enteredOnce.add(fill.mint);
            entrySlot.set(fill.mint, fill.slot);
          }
        } else {
          if ((buyLamports.get(fill.mint) ?? 0n) >= PROBE_QUOTE) roundTripped.add(fill.mint);
          entrySlot.delete(fill.mint);
          if (probeMint === fill.mint) {
            probeMint = null;
            probeWaitingSell = false;
          }
        }
      } else if (fill.status === "rejected" || fill.status === "failed") {
        if (fill.side === "buy") {
          failedBuySlot.set(fill.mint, batch.slot);
          if (kind !== undefined && kind.kind === "probe") {
            probeMint = null;
            probeWaitingSell = false;
            lastProbeAttemptSlot = batch.slot;
          }
        }
      }
    }

    for (const event of batch.events) {
      if (event.block_time !== null && event.block_time !== undefined) {
        if (firstBlockTime === 0) firstBlockTime = event.block_time;
        if (event.block_time > lastBlockTime) lastBlockTime = event.block_time;
      }
      if (event.event === "CreateEvent") {
        const tape = tapeFor(event.mint, event.slot);
        tape.created = event.slot;
      } else if (event.event === "TradeEvent") {
        const tape = tapeFor(event.mint, event.slot);
        tape.trades.push({
          slot: event.slot,
          price: priceOf(BigInt(event.virtual_quote_reserves), BigInt(event.virtual_token_reserves)),
          buy: event.is_buy,
          user: event.user,
          sol: BigInt(event.sol_amount),
        });
        if (tape.trades.length > TAPE_MAX) tape.trades.splice(0, tape.trades.length - TAPE_MAX);
      } else if (event.event === "CompleteEvent") {
        entrySlot.delete(event.mint);
        if (probeMint === event.mint) {
          probeMint = null;
          probeWaitingSell = false;
        }
      }
    }

    const txFee = state.txFeeLamports();
    let reserved = 0n;
    let buysSent = 0;

    const held = [...state.positions.keys()].sort();
    for (const mint of held) {
      if (orders.length >= MAX_ORDERS) break;
      if (pendingSell.has(mint)) continue;
      const position = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (position === undefined || curve === undefined || curve.complete) continue;
      const cost = position.cost_lamports;
      if (cost <= 0n) continue;
      const value = liquidValue(position.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves, curve.real_quote_reserves);
      const started = entrySlot.get(mint);
      let leave = false;
      if (value * 100n >= cost * TAKE_PROFIT_NUM) leave = true;
      else if (value * 100n <= cost * STOP_NUM) leave = true;
      else if (started !== undefined && now - started >= MAX_HOLD_SLOTS) leave = true;
      else if (probeMint === mint && probeWaitingSell) leave = true;
      if (!leave) continue;
      const id = `x${orderCounter}`;
      orderCounter++;
      sentKind.set(id, { mint, side: "sell", kind: probeMint === mint && probeWaitingSell ? "probe" : "exit" });
      orders.push({ side: "sell", client_id: id, mint, token_amount: position.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }

    if (state.committedPositionCount() + buysSent < MAX_OPEN) {
      const touched: string[] = [];
      for (const event of batch.events) {
        if (event.event === "TradeEvent") touched.push(event.mint);
      }
      const candidates = [...new Set(touched)].sort();
      for (const mint of candidates) {
        if (orders.length >= MAX_ORDERS) break;
        if (state.committedPositionCount() + buysSent >= MAX_OPEN) break;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const tape = tapes.get(mint);
        if (tape === undefined) continue;
        if (!entryReady(mint, tape, now, curve.real_quote_reserves)) continue;
        const cap = state.maxBuyLamports(mint);
        const capShare = (cap * 97n) / 100n;
        let size = ENTRY_QUOTE;
        if (size > capShare) size = capShare;
        const afford = state.freeCashLamports() - txFee - reserved;
        if (size > afford) size = afford;
        if (size < PROBE_QUOTE) continue;
        const id = `e${orderCounter}`;
        orderCounter++;
        sentKind.set(id, { mint, side: "buy", kind: "entry" });
        orders.push({ side: "buy", client_id: id, mint, quote_lamports: size, max_slippage_bps: BUY_SLIPPAGE_BPS });
        reserved += size + txFee;
        buysSent++;
      }
    }

    const elapsed = firstBlockTime > 0 && lastBlockTime > firstBlockTime ? lastBlockTime - firstBlockTime : 0;
    const expected = Math.min(PACE_TARGET, Math.floor((PACE_TARGET * elapsed) / PACE_WINDOW_SECONDS));
    if (
      probeMint === null &&
      !probeWaitingSell &&
      elapsed >= PACE_MIN_ELAPSED_SECONDS &&
      roundTripped.size < expected &&
      now - lastProbeAttemptSlot >= PROBE_COOLDOWN_SLOTS &&
      orders.length < MAX_ORDERS &&
      state.committedPositionCount() + buysSent < MAX_OPEN
    ) {
      const mints = [...state.curves.keys()].sort();
      for (const mint of mints) {
        if (orders.length >= MAX_ORDERS) break;
        if (state.committedPositionCount() + buysSent >= MAX_OPEN) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
        if (enteredOnce.has(mint) || probed.has(mint)) continue;
        if (curve.real_quote_reserves < PROBE_MIN_REAL_QUOTE) continue;
        const cap = state.maxBuyLamports(mint);
        if ((cap * 97n) / 100n < PROBE_QUOTE) continue;
        const afford = state.freeCashLamports() - txFee - reserved;
        if (afford < PROBE_QUOTE) continue;
        const id = `p${orderCounter}`;
        orderCounter++;
        sentKind.set(id, { mint, side: "buy", kind: "probe" });
        orders.push({ side: "buy", client_id: id, mint, quote_lamports: PROBE_QUOTE, max_slippage_bps: BUY_SLIPPAGE_BPS });
        reserved += PROBE_QUOTE + txFee;
        buysSent++;
        probeMint = mint;
        lastProbeAttemptSlot = now;
        break;
      }
    }

    return orders;
  },
});
