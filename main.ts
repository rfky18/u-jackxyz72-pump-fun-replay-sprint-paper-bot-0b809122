// Graduate-crossing rider for the pump.fun replay (agent-fun/replay/v2).
//
// What the dev window actually shows (measured on the dataset, not assumed):
//   - Most coins that ever graduate do it in a single slot: their whole
//     0 -> 85 SOL run happens inside one batch, so it is unbuyable (the
//     fill lands 2 slots later, after the CompleteEvent). Only a handful
//     of slow graduates can be ridden at all.
//   - After a coin's price has already risen a lot, the next move is more
//     often down than up: momentum chasing buys tops. Dip buying is no
//     better. No per-coin directional signal in this window is strongly
//     predictive on its own.
//   - The one robust, near-breakeven shape is: buy when a curve's real
//     SOL first crosses 1 SOL (it survived launch and real money is
//     flowing in), exit fast with a tight take-profit / stop-loss / max
//     hold, and let the harness's own slippage rule do the filtering.
//   - The slippage filter matters most: a buy decided on the batch for
//     slot s fills at slot s+2, and the fill is REJECTED for free when its
//     output is worse than the decision-time reserves imply by more than
//     max_slippage_bps. With a tight 200 bps buy slippage, buys that
//     would have chased a price that spiked in those 2 slots are simply
//     refused, so the bot only ever fills when the price held still over
//     the latency window. That single rule removes most of the worst
//     entries; without it the same policy loses ~2.5 SOL.
//   - Size is built by pyramiding winners only: the bot scales a position
//     up toward 0.5 SOL while its mark stays at or above entry, and never
//     adds while under water, so winning coins end up bigger than losers.
//
// The bot speaks the harness protocol through the SDK shim: hello opens the
// run, each batch carries that slot's events plus fills/marks, and onBatch
// answers with the orders for that slot (fills land latency_slots later).
// Everything is deterministic: no clock, no env, no Math.random — every
// decision is a pure function of the hello seed's run and the events seen.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n lamports
const TARGET_LAMPORTS = SOL / 2n; // 0.5 SOL target per position
const MIN_BUY_LAMPORTS = (SOL * 2n) / 100n; // 0.02 SOL smallest useful buy
const MAX_POSITIONS = 5;
// Tight buy slippage is the entry filter: fills that chased a spike are
// rejected for free instead of buying the top. Sells get wide slippage so
// an exit actually executes in a dump.
const BUY_SLIPPAGE_BPS = 200;
const SELL_SLIPPAGE_BPS = 2000;

// Entry: real SOL crossing 1 SOL from below (first sight counts as a
// crossing when the mint is first seen already above it).
const CROSS_REAL_SOL = 1.0;
const REENTRY_COOLDOWN_SLOTS = 300;

// Exits: tight and fast. Round-trip curve fees are ~2.5%, so TP +8% /
// SL -4% / 200-slot max hold is the breakeven-positive shape the data
// supports; wider targets just hand the move back.
const TAKE_PROFIT = 1.08; // +8% from entry
const STOP_LOSS = 0.96; // -4% from entry
const MAX_HOLD_SLOTS = 200;

interface MintStat {
  lastRealSol: number; // real SOL at the last batch this mint traded in
  entryPrice: number; // volume-weighted entry price while holding
  entrySlot: number;
  lastExitSlot: number; // slot of the last full exit (re-entry cooldown)
}

const stats = new Map<string, MintStat>();

function statFor(mint: string): MintStat {
  let s = stats.get(mint);
  if (!s) {
    s = { lastRealSol: 0, entryPrice: 0, entrySlot: 0, lastExitSlot: -1e9 };
    stats.set(mint, s);
  }
  return s;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

// Mints whose real SOL crossed 1 SOL from below in the batch being
// answered (first sight above the line counts as a crossing).
const crossedNow = new Set<string>();

// Fold this batch's fills into entry tracking, and spot real-SOL crossings
// of 1 SOL: compare each trade's real reserve against the value before
// this batch, then record the new value.
function ingestBatch(state: BotState, batch: Batch): void {
  crossedNow.clear();
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    const s = statFor(e.mint);
    const realSol = Number(BigInt(e.real_quote_reserves)) / 1e9;
    if (s.lastRealSol < CROSS_REAL_SOL && realSol >= CROSS_REAL_SOL) crossedNow.add(e.mint);
    s.lastRealSol = realSol;
  }
  for (const f of batch.fills) {
    if (f.status !== 'filled') continue;
    const s = statFor(f.mint);
    const curve = state.curves.get(f.mint);
    const mark = curve ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
    if (f.side === 'buy') {
      const tokens = Number(BigInt(f.token_amount));
      if (tokens > 0 && mark > 0) {
        if (s.entryPrice === 0) {
          s.entryPrice = mark;
          s.entrySlot = batch.slot;
        } else {
          // Volume-weighted entry as the position scales in.
          const held = state.positions.get(f.mint);
          const prevTokens = Math.max(0, Number(held?.token_amount ?? 0n) - tokens);
          s.entryPrice = (s.entryPrice * prevTokens + mark * tokens) / Math.max(1, prevTokens + tokens);
        }
      }
    } else if (f.side === 'sell') {
      const held = state.positions.get(f.mint);
      if (!held || held.token_amount === 0n) {
        // Fully out: reset entry tracking and start the re-entry cooldown.
        s.entryPrice = 0;
        s.entrySlot = 0;
        s.lastExitSlot = batch.slot;
      }
    }
  }
}

// Decide the orders for one batch. Exits first (protect open positions),
// then scale-ins on winners, then fresh crossings.
function decideOrders(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const nowSlot = batch.slot;

  // --- Exits: TP / SL / max hold on every held position. ---
  // Never re-issue a sell while one is already in flight for the mint:
  // the first sell fills 2 slots later, and duplicates only burn tx fees.
  const pendingSell = new Set<string>();
  const pendingBuy = new Set<string>();
  for (const p of state.pending.values()) {
    if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    else pendingBuy.add(p.order.mint);
  }
  for (const [mint, pos] of state.positions) {
    const curve = state.curves.get(mint);
    if (!curve || curve.complete) continue; // complete curves are closed by the harness
    if (pendingSell.has(mint)) continue;
    const s = stats.get(mint);
    if (!s || s.entryPrice === 0) continue;
    const mark = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (mark <= 0) continue;
    const gain = mark / s.entryPrice;
    if (
      gain >= TAKE_PROFIT ||
      gain <= STOP_LOSS ||
      nowSlot - s.entrySlot >= MAX_HOLD_SLOTS
    ) {
      if (pos.token_amount > 0n) {
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
      }
    }
  }

  const soldThisBatch = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.mint));

  // --- Scale-ins on open winners (every batch, not just crossings). ---
  for (const [mint, held] of state.positions) {
    if (orders.length >= 16) break;
    if (soldThisBatch.has(mint)) continue;
    if (pendingBuy.has(mint)) continue;
    if (held.cost_lamports >= TARGET_LAMPORTS) continue;
    const curve = state.curves.get(mint);
    if (!curve || curve.complete) continue;
    const s = stats.get(mint);
    if (!s || s.entryPrice === 0) continue;
    // Pyramid winners only: top up while the mark is at or above entry,
    // never average down a loser.
    const mark = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
    if (mark <= 0 || mark < s.entryPrice) continue;
    const cap = state.maxBuyLamports(mint);
    let amount = TARGET_LAMPORTS - held.cost_lamports;
    if (amount > cap) amount = cap;
    const free = state.freeCashLamports();
    if (amount > free - SOL / 2n) amount = free - SOL / 2n; // keep 0.5 SOL cash buffer
    if (amount >= MIN_BUY_LAMPORTS) {
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
    }
  }

  // --- Fresh entries on this batch's 1-SOL crossings. ---
  const buysThisReply = () => orders.filter((o) => o.side === 'buy').length;
  for (const mint of crossedNow) {
    if (orders.length >= 16) break;
    if (soldThisBatch.has(mint)) continue;
    if (pendingBuy.has(mint)) continue;
    if (state.positions.has(mint)) continue; // handled by the scale-in loop
    const curve = state.curves.get(mint);
    if (!curve || curve.complete) continue;
    const s = stats.get(mint);
    if (!s) continue;
    if (nowSlot - s.lastExitSlot < REENTRY_COOLDOWN_SLOTS) continue;
    // Fresh entry: needs a free position slot.
    if (state.committedPositionCount() + buysThisReply() >= MAX_POSITIONS) continue;
    const cap = state.maxBuyLamports(mint);
    let amount = TARGET_LAMPORTS;
    if (amount > cap) amount = cap;
    const free = state.freeCashLamports();
    if (amount > free - SOL / 2n) amount = free - SOL / 2n;
    if (amount >= MIN_BUY_LAMPORTS) {
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
    }
  }
  return orders;
}

await runBot({
  onHello(_state) {
    // Nothing to seed: every decision below is a pure function of the
    // hello + batch stream, which is what makes two runs byte-identical.
  },
  onBatch(state, batch) {
    ingestBatch(state, batch);
    return decideOrders(state, batch);
  },
});
