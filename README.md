[![btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/hurulsufi12-art/cbbtc-race-bot-2/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/hurulsufi12-art/cbbtc-race-bot-2/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

# First-Rally Rider + Dip Insurance

A long-only CBBTC trading bot for the make.fun bounty
[Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261123-0511)
($50 USDC escrowed, 10 paid places). One asset, $1,000 USDC, at most one
position, at most one order per 1-minute bar.

## Strategy

- **First-Rally Rider (main leg):** buy 100% of equity when the 60-minute
  return exceeds +60 bps. Exit on a trailing stop of −150 bps from the peak
  since entry. At most 2 momentum entries; a re-entry needs a pullback of
  at least 150 bps from the last peak, a fresh signal, and a 30-bar gap.
- **Dip Insurance (second leg):** buy in full when the 30-minute return is
  below −120 bps, or the 15-minute return is below −100 bps with the
  5-minute return above −20 bps (bounce confirmation). Exit at TP +100 bps,
  SL −100 bps, or a 15-bar max hold. A 15-bar cooldown follows any exit.
  When both legs signal on the same bar, the dip wins.
- **Late-entry guardrail:** if zero trades have filled by decided bar 1200
  and the 60-minute return is above +40 bps, take one last momentum entry.
- No entries after decided bar 1400, and no order on the last batch.
- The entry price always comes from the **fill** (reported one batch after
  the buy is decided), never from the decision bar's close. While a fill is
  pending (exactly one batch) the bot sends no exit and no new order.

All return comparisons are exact cross-multiplied bigint arithmetic — no
floats, no clock, no randomness, no network, no environment reads. Fully
deterministic: two runs on the same data produce byte-identical action logs.

## Files

- `main.ts` — the bot (Node 22, erasable TypeScript, stdlib only).
- `vendor/makefun-bars.ts` — the kit's `agent-fun/bars-replay/v1` shim,
  copied verbatim from the kit SDK.
- `README.md` — this file.
- `LICENSE` — MIT.

## Run

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1` on stdin/stdout (one `hello`,
then one `batch` per minute, one `reply` per batch echoing its `seq`).

## Local grade (dev window, 22–23 Nov 2026)

From the kit directory:

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-directory> --driver process
```

Expected (measured 23 Nov 2026, grade-local --driver process): dev net PnL
**+$18.45**, 2 round trips (4 fills), max drawdown 1.95%,
PnL at 2x fees +$16.82, guardrails met, L1 regrade reproduced byte for byte
(action log identical across independent runs). Neighbouring parameters
(trailing stop 120/180, threshold 50/70) all stay above +$15
(+$17.19–$21.26), and the same bot scores −$2.42 on the 18 Nov down-window
kit (guardrails met, max drawdown 1.85%) — a down-regime risk to note, not a
gate failure. Note: Sesi B's simulation predicted +$20.55 / +$2.03 for these
two windows; the gap is fully explained by its cost model (impact assumed
~7 bps/leg, real impact is 10–16 bps/leg at this window's pool depths) —
the bot's decisions (bars, fills, quantities) match the simulation exactly,
as verified by independent exact recomputation of all fills.
