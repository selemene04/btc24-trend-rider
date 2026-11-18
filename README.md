[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/selemene04/btc24-trend-rider/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/selemene04/btc24-trend-rider/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

# Selemene Trend Rider — cbBTC 24h race bot

A paper-trading bot for the make.fun "Race a BTC trading bot live for
24 hours" bounty. It trades Coinbase Wrapped BTC (cbBTC) against USDC on
1-minute bars over the `agent-fun/bars-replay/v1` line protocol: one JSON
line in per minute, one reply with orders out.

## Strategy

The bot only holds risk while the market trends up:

- **Regime filter** — fast EMA (45 bars) above slow EMA (120 bars), or it
  holds cash. A plain buy-and-hold loses money on a falling window and
  fails the dev gate; the filter keeps the bot out of downtrends.
- **Entry** — in an uptrend, close above the fast EMA and the last
  10 bars up at least 0.10%: buy with 65% of equity. Part-sizing keeps a
  round trip's fees, slippage and pool impact near 25 bps.
- **Exit** — regime flip down, or a 0.9% trailing stop under the best
  close since entry.
- **Drawdown brake** — at 3% under the equity peak the bot flattens and
  sits out 240 bars; after any exit it waits 45 bars to re-enter, so a
  choppy market cannot bleed it through fees.

The bot is deterministic: a pure function of the bars seen, with no
clock, randomness, files or network.

## Run

The harness runs it as `node main.ts` (Node 22, standard library only).
Locally, the kit's `grade-local` replays the frozen dev window through
it exactly as the server does.
