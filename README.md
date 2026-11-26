# First-Pullback Dip Rider

[![Pump.fun Bot Sprint](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ELVINO1806/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ELVINO1806/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for the Pump.fun Bot Sprint on make.fun. It trades
paper SOL on a replay of pump.fun bonding-curve events and is ranked on net
PnL.

## How it trades

The bot keeps a short trade tape for every curve it sees. It buys a coin
once, and only once, when all of these hold at decision time:

- the coin is at most 900 slots old;
- it holds at least 15 real SOL;
- it has run up at least 2x over a 2500-slot window;
- its price has dipped 8 to 50 percent below that window's high;
- its price has bounced at least 5 percent off the lowest price since that
  high;
- at least 5 distinct wallets bought in the last 30 slots;
- at least 3 of the last 6 trades are buys;
- net SOL flow over the last 30 slots is zero or positive.

Each entry risks 0.5 SOL, capped at 97 percent of the per-order buy cap for
that mint and at free cash minus one transaction fee. A position is sold in
full when its liquidation value reaches 1.25x cost, falls to 0.92x cost, or
after 450 slots held. There is no trailing stop and no second entry on a
coin.

## Guardrail probes

The competition needs round trips of at least 0.01 SOL on at least 20
different coins. If the bot's own filled round trips fall behind a pace of
25 coins across the replay window, it opens tiny 0.01 SOL probe round trips
on liquid curves it holds nothing in, at most one probe at a time, and sells
each probe as soon as its buy lands.

## Determinism

The bot never reads the clock, the environment or unseeded randomness. It
processes exits before entries in every batch and walks mints in sorted
order, so two runs produce the same orders.

## Layout

- `main.ts` — the whole strategy, plain erasable TypeScript, no
  dependencies.
- `vendor/makefun-bot.ts` — the kit's replay shim, copied unchanged.
- `.makefun/owner.json` — the payout wallet claim.

## License

MIT. See `LICENSE`.
