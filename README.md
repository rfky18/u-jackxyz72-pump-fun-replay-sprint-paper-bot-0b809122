# Pump.fun Replay Sprint — Paper Bot, Real Ranking

![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rfky18/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rfky18/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)

Breakout rider bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun).

## Strategy

Trades 10 SOL of paper money on a 24h pump.fun bonding-curve replay. It waits for
confirmed momentum instead of sniping at create:

- **Confirmed breakout**: price up over a ~510-slot window and still rising in the
  recent ~150-slot window, with recent buy volume dominating sells.
- **Overhang exhaustion**: selling pressure must not be growing versus the prior window.
- **Dispersed ownership**: at least 4 distinct buyers recently and no single buyer
  above 50% of recent buy flow (wallet-farm filter).
- **Survival filter**: the curve must already have raised ≥ 2 SOL of real reserve.

Exits are mechanical: +30% take-profit, −12% stop-loss, trailing stop once +15%
in profit, and a 900-slot max hold. Position size is 0.4 SOL per coin, scaled in
over replies (each reply's buys on one mint are capped at 100 bps of its real
reserve), max 5 open positions.

Fully deterministic: every decision is a pure function of the hello + batch
stream — no clock, no environment, no randomness.
