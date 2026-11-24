// sawit-pump-sprint-jack — launch sniper for agent-fun/replay/v2 (pump.fun).
//
// What the dev window taught us (grid-searched on the kit's simulator over
// the FULL window, then verified with grade-local): most fresh launches are
// noise and lose money, but the few that already hold >= 3 SOL of real buying
// within their first 3 slots, from at least 3 distinct non-creator wallets,
// lose the least and roughly break even in the window's first half. So we buy
// only those, with a small 0.05 SOL stake (the per-reply cap of 1% of real
// SOL binds first anyway), take profit fast at +20%, cut at -8%, never hold
// past 30 slots, and exit at once if the creator sells while we hold. One
// buy per coin, no adds: on the full window the add only added losses.
//
// Pure function of the batches: no clock, no randomness, no I/O, no network.
// Deterministic across runs, so the two replay executions agree.

import { BPS, runBot, type Batch, type BotState, type BuyInput, type OrderInput, type Pubkey, type SellInput } from './vendor/makefun-bot.ts';

// ---- tunables (lamports unless noted) ---------------------------------------
const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL per coin (per-reply cap binds first)
const MIN_BUY_LAMPORTS = 5_000_000n; // 0.005 SOL: smaller buys are not worth the tx fee
const MAX_AGE_SLOTS = 3; // first buy must be decided within 3 slots of creation
const MIN_REAL_SOL = 3_000_000_000n; // 3 SOL of real SOL in the curve at entry
const MAX_REAL_SOL = 30_000_000_000n; // 30 SOL: past this the launch is no longer early
const MAX_DEV_BUY = 2_500_000_000n; // 2.5 SOL: creator buying more smells like a setup
const MIN_EARLY_BUYERS = 3; // distinct non-creator buyers seen before entry
const MAX_EARLY_BUYERS = 3; // more than this in 3 slots smells like a bundled launch
const FLOW_WINDOW_SLOTS = 10;
const MIN_FLOW_LAMPORTS = 0n; // net flow over the window must not be negative
const TP_BPS = 2_000; // +20%: exit everything
const SL_BPS = 800; // -8%: exit everything
const MAX_HOLD_SLOTS = 30;
const FEE_BPS = 125n; // protocol 95 + creator 30 bps charged on curve trades

const WIDE_SLIPPAGE = 10_000;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  devSold: boolean;
  recent: Tick[];
  boughtOnce: boolean;
  done: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  devSoldAtOpen: boolean;
}

const coins = new Map<Pubkey, Coin>();
const held = new Map<Pubkey, Held>();
const selling = new Set<Pubkey>();

/** What selling `tokens` against (vq, vt) pays after the curve's 125 bps fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

/** Net flow (buys minus sells, lamports) over the window. */
function flowNet(c: Coin, slot: number): bigint {
  const from = slot - FLOW_WINDOW_SLOTS;
  let drop = 0;
  while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
  if (drop > 0) c.recent.splice(0, drop);
  let net = 0n;
  for (const t of c.recent) net += t.isBuy ? t.sol : -t.sol;
  return net;
}

function readEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      coins.set(e.mint, {
        mint: e.mint,
        createSlot: e.slot,
        creator: e.creator,
        devBuy: 0n,
        trades: 0,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        devSold: false,
        recent: [],
        boughtOnce: false,
        done: false,
      });
    } else if (e.event === 'TradeEvent') {
      const c = coins.get(e.mint);
      if (c === undefined) continue;
      const sol = BigInt(e.sol_amount);
      const isDev = e.user === c.creator;
      c.trades += 1;
      c.recent.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
      if (e.is_buy) {
        c.bought += sol;
        if (isDev && e.slot === c.createSlot) c.devBuy += sol;
        else if (!isDev) c.buyers.add(e.user);
      } else if (isDev) {
        c.devSold = true;
      } else {
        c.soldByOthers += sol;
      }
    } else {
      // CompleteEvent: the curve is done, never trade it again.
      const c = coins.get(e.mint);
      if (c !== undefined) c.done = true;
    }
  }
}

function hasPending(state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean {
  for (const p of state.pending.values()) {
    if (p.order.mint === mint && p.order.side === side) return true;
  }
  return false;
}

await runBot({
  onBatch(state, batch) {
    readEvents(batch);
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const tx = state.txFeeLamports();

    // Fold fills: track what we paid in tx fees per held coin, and clear state
    // for positions the harness closed itself (_complete / _flatten / _writeoff).
    for (const f of batch.fills) {
      if (f.client_id.startsWith('_')) {
        held.delete(f.mint);
        selling.delete(f.mint);
        continue;
      }
      const h = held.get(f.mint);
      if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
      if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
        held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports), devSoldAtOpen: coins.get(f.mint)?.devSold ?? false });
      }
    }
    for (const mint of [...selling]) if (!hasPending(state, mint, 'sell')) selling.delete(mint);
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) held.delete(mint);
    }

    // ---- exits first: never let a winner turn into a bag -------------------
    for (const [mint, pos] of state.positions) {
      if (orders.length >= cap) break;
      if (selling.has(mint)) continue;
      const c = coins.get(mint);
      let h = held.get(mint);
      if (h === undefined) {
        h = { openedSlot: state.slot, txPaid: tx, devSoldAtOpen: c?.devSold ?? false };
        held.set(mint, h);
      }
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - tx;
      const basis = pos.cost_lamports + h.txPaid;

      let exit = false;
      if (basis > 0n) {
        if (value * BPS >= basis * (BPS + BigInt(TP_BPS))) exit = true;
        if (value * BPS <= basis * (BPS - BigInt(SL_BPS))) exit = true;
      }
      if (state.slot - h.openedSlot >= MAX_HOLD_SLOTS) exit = true;
      if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: WIDE_SLIPPAGE } satisfies SellInput);
      selling.add(mint);
      if (c !== undefined) c.done = true;
    }

    // ---- entries: fresh launches that pass the filter -----------------------
    let free = state.freeCashLamports() - tx * BigInt(orders.length);
    let open = state.committedPositionCount();
    for (const c of coins.values()) {
      if (orders.length >= cap) break;
      if (c.done || c.boughtOnce) continue;
      const age = state.slot - c.createSlot;
      if (age > MAX_AGE_SLOTS) {
        c.done = true;
        continue;
      }
      if (open >= state.hello.caps.max_open_positions) continue;
      const curve = state.curves.get(c.mint);
      if (curve === undefined || curve.complete) continue;
      if (c.devSold) {
        c.done = true;
        continue;
      }
      const rq = curve.real_quote_reserves;
      if (rq < MIN_REAL_SOL || rq > MAX_REAL_SOL) continue;
      if (c.devBuy > MAX_DEV_BUY) continue;
      if (c.buyers.size < MIN_EARLY_BUYERS || c.buyers.size > MAX_EARLY_BUYERS) continue;
      // Skip when others have already sold more than was bought: the dump started.
      if (c.bought > 0n && c.soldByOthers > c.bought) continue;
      if (flowNet(c, state.slot) < MIN_FLOW_LAMPORTS) continue;
      const capBuy = state.maxBuyLamports(c.mint);
      const amount = STAKE_LAMPORTS < capBuy ? STAKE_LAMPORTS : capBuy;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: WIDE_SLIPPAGE } satisfies BuyInput);
      free -= amount + tx;
      c.boughtOnce = true;
      open += 1;
    }
    return orders;
  },
});
