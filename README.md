# Pump.fun Replay Sprint — Paper Bot, Real Ranking

![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)
![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rfky18/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)
![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rfky18/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)

Breakout rider bot for the [Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) bounty on [make.fun](https://make.fun).

## Strategy

Trades 10 SOL of paper money on a 24h pump.fun bonding-curve replay. It buys
when a curve's real SOL first crosses 1 SOL, and exits fast:

- **Entry**: real SOL crossing 1 SOL from below (the coin survived launch and
  real money is flowing in), except when the price already spiked more than
  3% inside this very batch (a 1-slot rocket's top is not bought). The
  harness's own slippage rule is the second filter: buys use a tight 200 bps
  max slippage, so a fill that would have chased a price spike over the
  2-slot latency is rejected for free instead of buying the top.
- **Sizing**: 0.3 SOL target per coin, scaled in only while the mark stays at
  least 2% above entry (pyramid winners, never average down a loser). Max 5
  open positions.
- **Exits**: +8% take-profit, −4% stop-loss, 200-slot max hold. Sells use
  10000 bps slippage so an exit always executes, even in a fast dump.

Fully deterministic: every decision is a pure function of the hello + batch
stream — no clock, no environment, no randomness.
