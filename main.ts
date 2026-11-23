// SPDX-License-Identifier: MIT
// "First-Rally Rider + Dip Insurance" — BTC race bot for btc-race-24h-20261123-0511.
// Long-only CBBTC bot on the agent-fun/bars-replay/v1 protocol: one hello, then one
// batch per minute, one reply per batch echoing its seq, at most one order per reply.
// Strategy (PLAN §4): ride the first 60-minute rally with a wide trailing stop
// (at most 2 momentum entries, re-entry only after a >=150 bps pullback from the
// last peak plus a fresh signal plus a 30-bar gap), scalp sharp dips with
// TP/SL +/-100 bps and a 15-bar max hold (dip first when both signals fire), and
// a late-entry guardrail: if zero trades filled by decided bar 1200 while the
// 60-minute return is above +40 bps, take one last momentum entry.
// All returns are compared exactly with cross-multiplied bigints, so strict
// thresholds (+60 bps means strictly more, never a float rounding artefact).
// The entry price always comes from the **fill** (reported one batch after
// the buy is decided), never from the decision bar's close. While a fill is
// pending (exactly one batch) the bot sends no exit and no new order.
// Fills are matched by the buy order's client_id (echoed verbatim by the
// harness): the fill fields decided_bar/fill_bar are BAR TIMES in ms, not
// seq numbers, so they must never be compared against state.seq. Likewise
// entryBar is the seq of the batch in which the fill arrives.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';
import { pathToFileURL } from 'node:url';

export const SYMBOL = 'CBBTC';

// Strategy constants (PLAN §5), all in basis points unless named otherwise.
export const MOM_THR60_BPS = 60;
export const MOM_TRAIL_BPS = 150;
export const MOM_MAX_ENTRIES = 2;
export const MOM_PULLBACK_BPS = 150;
export const MOM_REENTRY_GAP_BARS = 30;
export const DIP_THR30_BPS = -120;
export const DIP_THR15_BPS = -100;
export const DIP_BOUNCE5_BPS = -20;
export const DIP_TP_BPS = 100;
export const DIP_SL_BPS = -100;
export const DIP_MAX_HOLD_BARS = 15;
export const COOLDOWN_BARS = 15;
export const ENTRY_CUTOFF_BAR = 1400;
export const LAST_SEQ = 1439;
export const MAX_SLIPPAGE_BPS = 100;
export const MAX_TOTAL_ENTRIES = 4;
export const LATE_ENTRY_BAR = 1200;
export const LATE_ENTRY_THR60_BPS = 40;
export const MIN_NOTIONAL_QUOTE_UNITS = 1_000_000n; // $1 in USDC raw units

type Mode = 'mom' | 'dip';

interface Position {
  mode: Mode;
  /** Fill price (raw units at the symbol's price_scale), from batch.fills. */
  entryPx: bigint;
  /** Fill bar (decided bar + 1). */
  entryBar: number;
  /** Highest price since entry: fill price, then each close while held. */
  peakPx: bigint;
}

interface PendingFill {
  mode: Mode;
  decidedBar: number;
  /** client_id assigned to the buy order; the harness echoes it in the fill. */
  clientId: string;
}

/** Floor division for bigints (BigInt `/` truncates toward zero; floors matter at strict bounds). */
function divFloor(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  if (r !== 0n && ((r < 0n) !== (b < 0n))) return q - 1n;
  return q;
}

/**
 * Return in bps (floored) of the latest close against the close `h` bars back,
 * or null when fewer than h+1 closes exist. Pure function over raw closes.
 */
export function retBps(closes: readonly bigint[], h: number): bigint | null {
  if (closes.length <= h) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - h]!;
  return divFloor((now - then) * 10_000n, then);
}

/**
 * Exact sign of (return over `h` bars) minus `thrBps`, cross-multiplied so no
 * float is ever involved: positive means the return is strictly above thr.
 */
function cmpRet(closes: readonly bigint[], h: number, thrBps: number): number | null {
  if (closes.length <= h) return null;
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - h]!;
  const diff = (now - then) * 10_000n - BigInt(thrBps) * then;
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
}

/** Exact sign of (now/base - 1) in bps minus `thrBps`, cross-multiplied. */
function cmpMove(now: bigint, base: bigint, thrBps: number): number {
  const diff = (now - base) * 10_000n - BigInt(thrBps) * base;
  return diff > 0n ? 1 : diff < 0n ? -1 : 0;
}

export interface StrategyDebug {
  closes: number;
  position: Position | null;
  pendingFill: PendingFill | null;
  momEntries: number;
  totalEntries: number;
  lastExitBar: number;
  lastPeakPx: bigint;
}

export interface Strategy {
  onBatch(state: BarsState, batch: Batch): OrderInput[];
  debug(): StrategyDebug;
}

export function createStrategy(): Strategy {
  const closes: bigint[] = [];
  let position: Position | null = null;
  let pendingFill: PendingFill | null = null;
  let momEntries = 0;
  let totalEntries = 0;
  let lastExitBar = -1_000_000_000;
  let lastPeakPx = 0n;

  function pushClose(state: BarsState, batch: Batch): bigint | null {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return null;
    const close = BigInt(bar.c);
    closes.push(close);
    return close;
  }

  function onBatch(state: BarsState, batch: Batch): OrderInput[] {
    const seq = state.seq;

    // Step 0 — resolve a pending fill FIRST, even on a batch without a bar.
    // A buy decided on bar k fills at the open of bar k+1, reported in this
    // batch's fills. The entry price comes from fill.price, never from the
    // decision bar's close (open-vs-close moves up to ~20 bps in dev).
    if (pendingFill !== null) {
      const fill = batch.fills.find(
        (f) => f.side === 'buy' && f.symbol === SYMBOL && f.client_id === pendingFill!.clientId,
      );
      if (fill === undefined) {
        // Fill not reported yet: keep waiting, send nothing this batch.
        pushClose(state, batch);
        return [];
      }
      const mode = pendingFill.mode;
      pendingFill = null;
      if (fill.status !== 'filled') {
        // Rejected (e.g. max_slippage): no position; refund the entry count
        // so a later signal can retry from scratch.
        if (mode === 'mom' && momEntries > 0) momEntries -= 1;
        if (totalEntries > 0) totalEntries -= 1;
      } else {
        const entryPx = BigInt(fill.price);
        // entryBar is the seq of THIS batch (the fill batch), not
        // fill.fill_bar, which is a bar time in ms.
        position = { mode, entryPx, entryBar: seq, peakPx: entryPx };
      }
      // The fill batch itself is still a pending batch: no exit check and no
      // new order on it. The close still counts for history and for the peak.
      const close = pushClose(state, batch);
      if (position !== null && close !== null && close > position.peakPx) position.peakPx = close;
      return [];
    }

    // Step 1 — record this batch's close (nothing to decide without a bar).
    const close = pushClose(state, batch);
    if (close === null) return [];

    // Step 2 — warm-up batches never trade.
    if (state.warmingUp) return [];

    // Step 3 — manage an open position: exits only, never an entry here.
    if (position !== null) {
      if (close > position.peakPx) position.peakPx = close;
      const pos = position;
      let exit = false;
      if (pos.mode === 'mom') {
        // Trailing stop: close at or below -150 bps from the peak.
        exit = cmpMove(close, pos.peakPx, -MOM_TRAIL_BPS) <= 0;
      } else {
        exit =
          cmpMove(close, pos.entryPx, DIP_TP_BPS) >= 0 ||
          cmpMove(close, pos.entryPx, DIP_SL_BPS) <= 0 ||
          seq - pos.entryBar >= DIP_MAX_HOLD_BARS;
      }
      if (exit) {
        // Never order on the last batch: it is rejected (after_end) and the
        // harness flattens the position at the final close anyway.
        if (seq >= LAST_SEQ) return [];
        const held = state.positions.get(SYMBOL);
        if (held === undefined || held.qty <= 0n) {
          position = null;
          return [];
        }
        if (pos.mode === 'mom') lastPeakPx = pos.peakPx;
        lastExitBar = seq;
        position = null;
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Step 4 — flat: entries only, at most one order per reply.
    if (totalEntries >= MAX_TOTAL_ENTRIES) return [];
    if (seq > ENTRY_CUTOFF_BAR) return [];
    if (seq - lastExitBar < COOLDOWN_BARS) return [];

    const dipSignal =
      (cmpRet(closes, 30, DIP_THR30_BPS) ?? 1) < 0 ||
      (((cmpRet(closes, 15, DIP_THR15_BPS) ?? 1) < 0) &&
        ((cmpRet(closes, 5, DIP_BOUNCE5_BPS) ?? -1) > 0));
    const momSignal =
      (cmpRet(closes, 60, MOM_THR60_BPS) ?? -1) > 0 &&
      momEntries < MOM_MAX_ENTRIES &&
      (momEntries === 0 ||
        (cmpMove(close, lastPeakPx, -MOM_PULLBACK_BPS) <= 0 &&
          seq - lastExitBar >= MOM_REENTRY_GAP_BARS));
    const lateSignal =
      totalEntries === 0 &&
      seq >= LATE_ENTRY_BAR &&
      (cmpRet(closes, 60, LATE_ENTRY_THR60_BPS) ?? -1) > 0;

    // Dip first when both signals fire on the same bar (shorter horizon).
    let mode: Mode | null = null;
    if (dipSignal) mode = 'dip';
    else if (momSignal || lateSignal) mode = 'mom';
    if (mode === null) return [];

    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    const floor = minNotional > MIN_NOTIONAL_QUOTE_UNITS ? minNotional : MIN_NOTIONAL_QUOTE_UNITS;
    if (state.cash < floor) return [];
    const clientId = `buy-${seq}`;
    pendingFill = { mode, decidedBar: seq, clientId };
    if (mode === 'mom') momEntries += 1;
    totalEntries += 1;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: clientId }];
  }

  function debug(): StrategyDebug {
    return {
      closes: closes.length,
      position,
      pendingFill,
      momEntries,
      totalEntries,
      lastExitBar,
      lastPeakPx,
    };
  }

  return { onBatch, debug };
}

// Run the wire loop only when this file is the entrypoint (`node main.ts`);
// importing it from a test harness must not start reading stdin.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const strategy = createStrategy();
  await runBars({ onBatch: (state, batch) => strategy.onBatch(state, batch) });
}
