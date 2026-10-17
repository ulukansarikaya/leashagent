import type { Dec } from "./types.js";

/** Minimal exact decimal helper (no floats). Scale is fixed at 18 digits internally. */
const SCALE = 18n;
const ONE = 10n ** SCALE;

export function toBig(d: Dec): bigint {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(d);
  if (!m) throw new Error(`bad decimal: ${d}`);
  const frac = (m[3] ?? "").padEnd(Number(SCALE), "0").slice(0, Number(SCALE));
  const v = BigInt(m[2]!) * ONE + BigInt(frac || "0");
  return m[1] ? -v : v;
}

export function fromBig(v: bigint, places = 8): Dec {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const scaleDown = 10n ** (SCALE - BigInt(places));
  const r = a / scaleDown;
  const s = r.toString().padStart(places + 1, "0");
  const out = places ? `${s.slice(0, -places)}.${s.slice(-places)}` : s;
  return (neg && r !== 0n ? "-" : "") + out;
}

export const decMul = (a: Dec, b: Dec): Dec => fromBig((toBig(a) * toBig(b)) / ONE);
export const decDiv = (a: Dec, b: Dec): Dec => fromBig((toBig(a) * ONE) / toBig(b));
export const decAdd = (a: Dec, b: Dec): Dec => fromBig(toBig(a) + toBig(b));
export const decSub = (a: Dec, b: Dec): Dec => fromBig(toBig(a) - toBig(b));
export const decCmp = (a: Dec, b: Dec): -1 | 0 | 1 => {
  const x = toBig(a), y = toBig(b);
  return x < y ? -1 : x > y ? 1 : 0;
};
