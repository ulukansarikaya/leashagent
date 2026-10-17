import type { Signal } from "@bekci/shared";
import type { MarketView } from "./market.js";

export type SignalParams = { fast: number; slow: number; minSpread: number; minVolRatio: number };
export const DEFAULT_SIGNAL: SignalParams = { fast: 5, slow: 20, minSpread: 0.001, minVolRatio: 0.5 };

/**
 * Deterministic SMA-crossover signal with a volume filter (§6.2).
 * Floats are fine here: the signal is advisory and never feeds Bekçi's risk math.
 */
export function generateSignal(m: MarketView, p: SignalParams = DEFAULT_SIGNAL): Signal {
  const closes = m.candles.map((c) => Number(c.close));
  const vols = m.candles.map((c) => Number(c.vol));
  const now = Math.floor(Date.now() / 1000);
  if (closes.length < p.slow) {
    return { instId: m.instId, direction: "flat", strength: "0", basis: [{ name: "insufficient_candles", value: String(closes.length) }], computedAt: now };
  }
  const sma = (xs: number[], n: number) => xs.slice(-n).reduce((a, b) => a + b, 0) / n;
  const fast = sma(closes, p.fast);
  const slow = sma(closes, p.slow);
  const spread = (fast - slow) / slow;
  const volRatio = sma(vols, p.fast) / Math.max(sma(vols, p.slow), 1e-12);

  let direction: Signal["direction"] = "flat";
  if (volRatio >= p.minVolRatio && Math.abs(spread) >= p.minSpread) direction = spread > 0 ? "long_bias" : "exit_bias";
  const strength = Math.min(1, Math.abs(spread) / (p.minSpread * 5));

  return {
    instId: m.instId,
    direction,
    strength: direction === "flat" ? "0" : strength.toFixed(4),
    basis: [
      { name: "sma_fast", value: fast.toFixed(8) },
      { name: "sma_slow", value: slow.toFixed(8) },
      { name: "sma_spread", value: spread.toFixed(8) },
      { name: "vol_ratio", value: volRatio.toFixed(4) },
    ],
    computedAt: now,
  };
}
