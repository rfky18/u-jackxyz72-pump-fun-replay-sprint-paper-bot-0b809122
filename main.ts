// Breakout rider for the pump.fun replay (agent-fun/replay/v2).
//
// Idea, from first principles on a bonding curve: price = virtual SOL /
// virtual tokens, so price only rises while net buy flow pushes real SOL
// into the curve. A blind snipe at create buys before any flow exists and
// pays fees on noise. This bot instead waits for CONFIRMED momentum:
//   1. the curve has already raised substantial real SOL (a survivor on
//      its final leg toward graduation, not a fresh launch),
//   2. price is up over a multi-hundred-slot window AND still rising in the
//      recent window (accelerating buy flow, not a single spike),
//   3. recent buy volume dominates sells and selling pressure is fading
//      (overhang exhaustion),
//   4. buying is dispersed across many wallets (no single wallet farming
//      the flow — a concentrated top buyer is skipped).
// Exits are mechanical: take-profit, stop-loss, trailing stop once the
// trade is in profit, a momentum-collapse exit when buy flow flips to
// sells, and a slot-based max hold. Position size is small
// (0.3 SOL target) and built up over several replies because each reply's
// buys on one mint are capped at 100 bps of its real reserve.
//
// The bot speaks the harness protocol through the SDK shim: hello opens the
// run, each batch carries that slot's events plus fills/marks, and onBatch
// answers with the orders for that slot (fills land latency_slots later).
// Everything is deterministic: no clock, no env, no Math.random — every
// decision is a pure function of the hello seed's run and the events seen.

import { runBot, LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';
import type { Batch, BotState, OrderInput } from './vendor/makefun-bot.ts';

const SOL = LAMPORTS_PER_SOL; // 1_000_000_000n lamports
const TARGET_LAMPORTS = (SOL * 3n) / 10n; // 0.3 SOL target per position
const MIN_BUY_LAMPORTS = (SOL * 2n) / 100n; // 0.02 SOL smallest useful buy
const MAX_POSITIONS = 5;
const BUY_SLIPPAGE_BPS = 1000;
const SELL_SLIPPAGE_BPS = 2000; // wide: an exit that gets rejected in a dump is worthless

// Entry gates v2 — buy SURVIVORS, not fresh launches. A buy on one mint is
// capped at 100 bps of its real reserve, so a 0.3 SOL position needs real
// reserve >= 30 SOL to fill in one reply; coins that raised that much real
// SOL and are still surging are the ones whose final leg toward graduation
// (85 SOL) is the most reliable momentum in the window. Fresh coins mostly
// die after their first spike, so buying them after +8% was buying tops.
const MIN_REAL_SOL = 15.0; // curve must have raised >= 15 SOL of real reserve
const MOMENTUM_WINDOW = 300; // slots of price history an entry needs
const RECENT_WINDOW = 120; // slots of the "recent" flow window
const MIN_MOMENTUM = 1.04; // price now vs ~300 slots ago
const MIN_RECENT_RISE = 1.01; // price now vs ~120 slots ago
const MIN_BUY_DOMINANCE = 1.3; // recent buy SOL >= 1.3x recent sell SOL
const MIN_BUYERS = 3; // distinct buyers in the recent window
const MAX_TOP_BUYER_SHARE = 0.6; // largest single buyer <= 60% of recent buys

// Exit rules v2 — tight, because round-trip fees are ~2.5% and a pump.fun
// surge reverses fast. TP +15% / SL -7% needs only a ~46% win rate to
// break even before fees; the trailing stop locks in the good runs.
const TAKE_PROFIT = 1.15; // +15% from entry
const STOP_LOSS = 0.93; // -7% from entry
const TRAIL_TRIGGER = 1.08; // trailing arms once +8%
const TRAIL_DROP = 0.95; // sell at 5% below the peak after arming
const SOFT_EXIT_DROP = 0.96; // sell at 4% below peak once +5% in profit
const SOFT_EXIT_TRIGGER = 1.05;
const MAX_HOLD_SLOTS = 600;

interface Sample {
  slot: number;
  price: number; // virtual SOL / virtual tokens (lamports per token unit)
  buySol: number; // SOL bought in this batch's trades on this mint
  sellSol: number; // SOL sold in this batch's trades on this mint
  buyers: Map<string, number>; // buyer address -> SOL bought in this batch
}

interface MintStat {
  samples: Sample[];
  entryPrice: number; // volume-weighted entry price while holding
  entrySlot: number;
  peakPrice: number; // highest mark price seen while holding
  lastExitSlot: number; // slot of the last full exit (cooldown)
  seenSlot: number; // last slot this mint had any trade
}

const stats = new Map<string, MintStat>();

function statFor(mint: string): MintStat {
  let s = stats.get(mint);
  if (!s) {
    s = { samples: [], entryPrice: 0, entrySlot: 0, peakPrice: 0, lastExitSlot: -1e9, seenSlot: 0 };
    stats.set(mint, s);
  }
  return s;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt <= 0n) return 0;
  return Number(vq) / Number(vt);
}

// Aggregate one mint's samples over the recent and prior windows ending at
// `nowSlot`. Returns null when there is not enough history to judge.
function windowStats(s: MintStat, nowSlot: number) {
  const recentFrom = nowSlot - RECENT_WINDOW;
  const priorFrom = nowSlot - MOMENTUM_WINDOW;
  let pOld = 0;
  let pRecentStart = 0;
  let buyR = 0;
  let sellR = 0;
  let buyP = 0;
  let sellP = 0;
  const buyersR = new Map<string, number>();
  let haveOld = false;
  let haveRecentStart = false;
  for (const sm of s.samples) {
    if (sm.slot < priorFrom) continue;
    if (!haveOld) {
      pOld = sm.price;
      haveOld = true;
    }
    if (sm.slot >= recentFrom) {
      if (!haveRecentStart) {
        pRecentStart = sm.price;
        haveRecentStart = true;
      }
      buyR += sm.buySol;
      sellR += sm.sellSol;
      for (const [u, v] of sm.buyers) buyersR.set(u, (buyersR.get(u) ?? 0) + v);
    } else {
      buyP += sm.buySol;
      sellP += sm.sellSol;
    }
  }
  if (!haveOld || !haveRecentStart) return null;
  let topBuyer = 0;
  for (const v of buyersR.values()) if (v > topBuyer) topBuyer = v;
  return {
    pOld,
    pRecentStart,
    buyR,
    sellR,
    buyP,
    sellP,
    buyers: buyersR.size,
    topShare: buyR > 0 ? topBuyer / buyR : 1,
  };
}

// Fold this batch's events into per-mint flow samples. Called from onBatch
// after the shim has already applied the batch to the state (so the curves
// carry the latest reserves), but the raw events are what give buy/sell
// flow, distinct buyers and the price path.
function ingestBatch(state: BotState, batch: Batch): void {
  const byMint = new Map<string, Sample>();
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    const curve = state.curves.get(e.mint);
    if (!curve) continue;
    let sm = byMint.get(e.mint);
    if (!sm) {
      sm = { slot: batch.slot, price: priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves), buySol: 0, sellSol: 0, buyers: new Map() };
      byMint.set(e.mint, sm);
    }
    const sol = Number(BigInt(e.sol_amount)) / 1e9;
    if (e.is_buy) {
      sm.buySol += sol;
      sm.buyers.set(e.user, (sm.buyers.get(e.user) ?? 0) + sol);
    } else {
      sm.sellSol += sol;
    }
  }
  for (const [mint, sm] of byMint) {
    const s = statFor(mint);
    // One sample per batch per mint; keep only the momentum window.
    const last = s.samples[s.samples.length - 1];
    if (last && last.slot === batch.slot) {
      last.buySol += sm.buySol;
      last.sellSol += sm.sellSol;
      for (const [u, v] of sm.buyers) last.buyers.set(u, (last.buyers.get(u) ?? 0) + v);
    } else {
      s.samples.push(sm);
    }
    s.seenSlot = batch.slot;
    while (s.samples.length > 0 && s.samples[0].slot < batch.slot - MOMENTUM_WINDOW - 60) s.samples.shift();
  }
  // Fold fills: track entry price / peak while holding, clear on full exit.
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
          s.peakPrice = mark;
        } else {
          // Volume-weighted entry as the position scales in.
          const prevTokens = Math.max(0, Number(state.positions.get(f.mint)?.token_amount ?? 0n) - tokens);
          s.entryPrice = (s.entryPrice * prevTokens + mark * tokens) / Math.max(1, prevTokens + tokens);
        }
        if (mark > s.peakPrice) s.peakPrice = mark;
      }
    } else if (f.side === 'sell') {
      const held = state.positions.get(f.mint);
      if (!held || held.token_amount === 0n) {
        // Fully out: reset entry tracking and start the re-entry cooldown.
        s.entryPrice = 0;
        s.entrySlot = 0;
        s.peakPrice = 0;
        s.lastExitSlot = batch.slot;
      }
    }
  }
  // Prune dead mints (no trade for a long while, not held) to bound memory.
  if (stats.size > 4000) {
    for (const [mint, s] of stats) {
      if (batch.slot - s.seenSlot > 5000 && !state.positions.has(mint)) stats.delete(mint);
    }
  }
}

// Decide the orders for one batch. Exits first (protect open positions),
// then entries on mints whose flow just confirmed a breakout.
function decideOrders(state: BotState, batch: Batch): OrderInput[] {
  const orders: OrderInput[] = [];
  const nowSlot = batch.slot;

  // --- Exits: every held position is re-priced against its entry/peak. ---
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
    if (mark > s.peakPrice) s.peakPrice = mark;
    const gain = mark / s.entryPrice;
    const fromPeak = mark / s.peakPrice;
    const heldSlots = nowSlot - s.entrySlot;
    // Momentum-collapse exit: the buy flow that justified the entry has
    // flipped to sell dominance while the trade is barely in profit.
    const w = windowStats(s, nowSlot);
    const flowFlipped = w !== null && w.sellR > w.buyR * 1.5 && gain < 1.05;
    const shouldExit =
      gain >= TAKE_PROFIT ||
      gain <= STOP_LOSS ||
      (s.peakPrice >= s.entryPrice * TRAIL_TRIGGER && fromPeak <= TRAIL_DROP) ||
      (s.peakPrice >= s.entryPrice * SOFT_EXIT_TRIGGER && fromPeak <= SOFT_EXIT_DROP) ||
      flowFlipped ||
      heldSlots >= MAX_HOLD_SLOTS;
    if (shouldExit && pos.token_amount > 0n) {
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: SELL_SLIPPAGE_BPS });
    }
  }

  // --- Entries: only mints that traded in this batch, with full history. ---
  const soldThisBatch = new Set(orders.filter((o) => o.side === 'sell').map((o) => o.mint));
  if (state.committedPositionCount() < MAX_POSITIONS) {
    const traded = new Set<string>();
    for (const e of batch.events) if (e.event === 'TradeEvent') traded.add(e.mint);
    for (const mint of traded) {
      if (orders.length >= 16) break;
      if (soldThisBatch.has(mint)) continue;
      if (state.positions.has(mint)) {
        // Scale-in: top up a held position toward target while flow confirms.
        // One buy in flight at a time: a pending buy's tokens are not in
        // state.positions yet, so without this the bot would over-commit.
        if (pendingBuy.has(mint)) continue;
        const s = stats.get(mint);
        const curve = state.curves.get(mint);
        if (!s || !curve || curve.complete) continue;
        const held = state.positions.get(mint)!;
        const invested = held.cost_lamports;
        if (invested >= TARGET_LAMPORTS) continue;
        const w = windowStats(s, nowSlot);
        if (!w) continue;
        const pNow = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (pNow <= 0 || pNow < s.entryPrice * 0.98) continue; // only add while near/above entry
        if (w.buyR < w.sellR * 1.2) continue;
        const cap = state.maxBuyLamports(mint);
        let amount = TARGET_LAMPORTS - invested;
        if (amount > cap) amount = cap;
        const free = state.freeCashLamports();
        if (amount > free - SOL / 2n) amount = free - SOL / 2n; // keep 0.5 SOL cash buffer
        if (amount >= MIN_BUY_LAMPORTS) {
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
        }
        continue;
      }
      if (state.committedPositionCount() + orders.filter((o) => o.side === 'buy').length >= MAX_POSITIONS) continue;
      if (pendingBuy.has(mint)) continue;
      const s = stats.get(mint);
      const curve = state.curves.get(mint);
      if (!s || !curve || curve.complete) continue;
      if (nowSlot - s.lastExitSlot < 600) continue; // cooldown after an exit
      const realSol = Number(curve.real_quote_reserves) / 1e9;
      if (realSol < MIN_REAL_SOL) continue;
      const w = windowStats(s, nowSlot);
      if (!w) continue;
      const pNow = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (pNow <= 0) continue;
      const momentum = pNow / w.pOld;
      const recentRise = pNow / w.pRecentStart;
      if (momentum < MIN_MOMENTUM) continue;
      if (recentRise < MIN_RECENT_RISE) continue;
      if (w.buyR < w.sellR * MIN_BUY_DOMINANCE) continue; // buy flow must dominate
      if (w.buyR <= w.buyP * 0.8) continue; // flow must not be collapsing
      if (w.sellR > w.sellP * 1.2 && w.sellP > 0) continue; // overhang must not be growing
      if (w.buyers < MIN_BUYERS) continue; // dispersed ownership proxy
      if (w.topShare > MAX_TOP_BUYER_SHARE) continue; // skip wallet-farm flow
      const cap = state.maxBuyLamports(mint);
      let amount = TARGET_LAMPORTS;
      if (amount > cap) amount = cap;
      const free = state.freeCashLamports();
      if (amount > free - SOL / 2n) amount = free - SOL / 2n;
      if (amount >= MIN_BUY_LAMPORTS) {
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      }
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
