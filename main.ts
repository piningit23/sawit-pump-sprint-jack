// sawit-pump-sprint-jack — launch sniper for agent-fun/replay/v2 (pump.fun).
//
// Idea: most pump.fun coins die within minutes, but a small slice runs hard in
// its first slots. So we only buy fresh launches that look organic — a modest
// creator buy, few distinct early buyers (a launch bundled by many wallets is
// usually a creator cluster waiting to dump), no creator sell yet, real SOL
// already flowing in — and we get out fast: partial profit at +10%, full exit
// at +18%, hard stop at -10%, a trailing stop once up +12%, a 15-slot max
// hold, and an instant exit if the creator sells while we hold.
//
// Pure function of the batches: no clock, no randomness, no I/O, no network.
// Deterministic across runs, so the two replay executions agree.

import { BPS, runBot, type Batch, type BotState, type BuyInput, type OrderInput, type Pubkey, type SellInput } from './vendor/makefun-bot.ts';

// ---- tunables (lamports unless noted) ---------------------------------------
const STAKE_LAMPORTS = 100_000_000n; // 0.10 SOL per coin
const MIN_BUY_LAMPORTS = 5_000_000n; // 0.005 SOL: smaller buys are not worth the tx fee
const MAX_AGE_SLOTS = 3; // first buy must be decided within 3 slots of creation
const MIN_REAL_SOL = 500_000_000n; // 0.5 SOL of real SOL in the curve at entry
const MAX_REAL_SOL = 30_000_000_000n; // 30 SOL: past this the launch is no longer early
const MAX_DEV_BUY = 2_500_000_000n; // 2.5 SOL: creator buying more smells like a setup
const MAX_EARLY_BUYERS = 3; // distinct non-creator buyers seen before entry
const MAX_RUNUP_BPS = 13_000; // +30% over the create price: never chase a pumped coin
// (run-up is measured in bps with 10_000 = the create price itself, so +30% is 13_000)
const FLOW_WINDOW_SLOTS = 10;
const MIN_FLOW_LAMPORTS = 0n; // net flow over the window must not be negative
const TP1_BPS = 1_000; // +10%: sell half
const TP1_PART_BPS = 5_000; // 50% of the position
const TP_BPS = 1_800; // +18%: exit everything
const SL_BPS = 1_000; // -10%: exit everything
const SL_AFTER_TP1_BPS = 0n; // after the partial, the rest stops out at breakeven
const TRAIL_ARM_BPS = 1_200; // +12%: arm the trailing stop
const TRAIL_BPS = 800; // exit on an 8% fall from the best value seen
const MAX_HOLD_SLOTS = 15;
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
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  devSold: boolean;
  lastTradeSlot: number;
  recent: Tick[];
  boughtOnce: boolean;
  done: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  devSoldAtOpen: boolean;
  tookTp1: boolean;
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

/** Net flow (buys minus sells, lamports) and distinct buyers over the window. */
function flow(c: Coin, slot: number): { net: bigint; buyers: number } {
  const from = slot - FLOW_WINDOW_SLOTS;
  let drop = 0;
  while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
  if (drop > 0) c.recent.splice(0, drop);
  let net = 0n;
  const buyers = new Set<Pubkey>();
  for (const t of c.recent) {
    if (t.isBuy) {
      net += t.sol;
      if (t.user !== c.creator) buyers.add(t.user);
    } else {
      net -= t.sol;
    }
  }
  return { net, buyers: buyers.size };
}

function readEvents(batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      coins.set(e.mint, {
        mint: e.mint,
        createSlot: e.slot,
        creator: e.creator,
        vq0: BigInt(e.virtual_quote_reserves),
        vt0: BigInt(e.virtual_token_reserves),
        devBuy: 0n,
        trades: 0,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        devSold: false,
        lastTradeSlot: e.slot,
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
      c.lastTradeSlot = e.slot;
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
        held.set(f.mint, {
          openedSlot: f.slot,
          txPaid: BigInt(f.tx_fee_lamports),
          best: 0n,
          devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
          tookTp1: false,
        });
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
        h = { openedSlot: state.slot, txPaid: tx, best: 0n, devSoldAtOpen: c?.devSold ?? false, tookTp1: false };
        held.set(mint, h);
      }
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      const value = sellValue(pos.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves) - tx;
      const basis = pos.cost_lamports + h.txPaid;
      if (value > h.best) h.best = value;

      let exit = false;
      if (basis > 0n) {
        // Partial take-profit at +10%: bank half, let the rest ride.
        if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(TP1_BPS))) {
          const part = (pos.token_amount * BigInt(TP1_PART_BPS)) / BPS;
          if (part > 0n && part < pos.token_amount) {
            orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: WIDE_SLIPPAGE } satisfies SellInput);
            selling.add(mint);
            h.tookTp1 = true;
            h.best = 0n;
            continue;
          }
        }
        if (value * BPS >= basis * (BPS + BigInt(TP_BPS))) exit = true;
        const sl = h.tookTp1 ? SL_AFTER_TP1_BPS : BigInt(SL_BPS);
        if (value * BPS <= basis * (BPS - sl)) exit = true;
        if (h.best * BPS >= basis * (BPS + BigInt(TRAIL_ARM_BPS)) && value * BPS <= h.best * (BPS - BigInt(TRAIL_BPS))) exit = true;
      }
      if (state.slot - h.openedSlot >= MAX_HOLD_SLOTS) exit = true;
      if (c !== undefined && c.devSold && !h.devSoldAtOpen) exit = true;
      if (!exit) continue;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: WIDE_SLIPPAGE } satisfies SellInput);
      selling.add(mint);
      if (c !== undefined) c.done = true;
    }

    // ---- entries: fresh launches that pass the rug filter -------------------
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
      if (c.buyers.size > MAX_EARLY_BUYERS) continue;
      // Price run-up since creation: (vq/vt) now vs (vq0/vt0) at create.
      if (c.vt0 > 0n && c.vq0 > 0n) {
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
        if (runup > BigInt(MAX_RUNUP_BPS)) continue;
      }
      if (flow(c, state.slot).net < MIN_FLOW_LAMPORTS) continue;
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
