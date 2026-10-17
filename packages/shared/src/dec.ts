import type { Dec } from "./types.js";

// Exact decimal arithmetic on Dec strings (P10). BigInt-backed, never touches floats.

export const DEC_RE = /^-?\d+(\.\d+)?$/;

type Raw = { int: bigint; scale: number }; // value = int / 10^scale

function parse(s: Dec): Raw {
  if (typeof s !== "string" || !DEC_RE.test(s)) throw new TypeError(`invalid Dec: ${String(s)}`);
  const neg = s.startsWith("-");
  const [whole, frac = ""] = (neg ? s.slice(1) : s).split(".");
  const int = BigInt(whole + frac);
  return { int: neg ? -int : int, scale: frac.length };
}

function align(a: Raw, b: Raw): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.int * 10n ** BigInt(scale - a.scale), b.int * 10n ** BigInt(scale - b.scale), scale];
}

/** Truncate toward zero to `scale` digits. */
function rescaleDown(r: Raw, scale: number): Raw {
  if (scale >= r.scale) return { int: r.int * 10n ** BigInt(scale - r.scale), scale };
  return { int: r.int / 10n ** BigInt(r.scale - scale), scale }; // BigInt division truncates toward zero
}

function format(r: Raw, keepScale: boolean): Dec {
  const neg = r.int < 0n;
  let digits = (neg ? -r.int : r.int).toString().padStart(r.scale + 1, "0");
  let out = r.scale === 0 ? digits : digits.slice(0, -r.scale) + "." + digits.slice(-r.scale);
  if (!keepScale && r.scale > 0) out = out.replace(/\.?0+$/, "");
  if (neg && /[1-9]/.test(out)) out = "-" + out;
  return out;
}

export interface DecimalOps {
  add(b: Dec | DecimalOps): DecimalOps;
  sub(b: Dec | DecimalOps): DecimalOps;
  mul(b: Dec | DecimalOps): DecimalOps;
  /** Divide, truncating toward zero at `scale` fractional digits. */
  div(b: Dec | DecimalOps, scale: number): DecimalOps;
  /** Multiply by (1 + bps/10000). */
  addBps(bps: number): DecimalOps;
  neg(): DecimalOps;
  abs(): DecimalOps;
  cmp(b: Dec | DecimalOps): -1 | 0 | 1;
  eq(b: Dec | DecimalOps): boolean;
  lt(b: Dec | DecimalOps): boolean;
  lte(b: Dec | DecimalOps): boolean;
  gt(b: Dec | DecimalOps): boolean;
  gte(b: Dec | DecimalOps): boolean;
  isZero(): boolean;
  isNegative(): boolean;
  /** Round down (toward zero) to a multiple of `step` (e.g. lotSz/tickSz). */
  floorToStep(step: Dec): DecimalOps;
  /** Fixed-scale string, truncating toward zero; keeps trailing zeros. */
  toFixed(scale: number): Dec;
  /** Minimal string: no trailing zeros, "-0" collapses to "0". */
  toString(): Dec;
}

const toRaw = (x: Dec | DecimalOps): Raw => parse(typeof x === "string" ? x : x.toString());

function wrap(r: Raw): DecimalOps {
  const self: DecimalOps = {
    add: (b) => { const [x, y, s] = align(r, toRaw(b)); return wrap({ int: x + y, scale: s }); },
    sub: (b) => { const [x, y, s] = align(r, toRaw(b)); return wrap({ int: x - y, scale: s }); },
    mul: (b) => { const o = toRaw(b); return wrap({ int: r.int * o.int, scale: r.scale + o.scale }); },
    div: (b, scale) => {
      const o = toRaw(b);
      if (o.int === 0n) throw new RangeError("Dec division by zero");
      // r/o at `scale` digits = r.int * 10^(scale + o.scale - r.scale) / o.int
      const shift = scale + o.scale - r.scale;
      const num = shift >= 0 ? r.int * 10n ** BigInt(shift) : r.int / 10n ** BigInt(-shift);
      return wrap({ int: num / o.int, scale });
    },
    addBps: (bps) => {
      if (!Number.isInteger(bps)) throw new TypeError("bps must be an integer");
      return wrap({ int: r.int * (10000n + BigInt(bps)), scale: r.scale + 4 });
    },
    neg: () => wrap({ int: -r.int, scale: r.scale }),
    abs: () => wrap({ int: r.int < 0n ? -r.int : r.int, scale: r.scale }),
    cmp: (b) => { const [x, y] = align(r, toRaw(b)); return x < y ? -1 : x > y ? 1 : 0; },
    eq: (b) => self.cmp(b) === 0,
    lt: (b) => self.cmp(b) < 0,
    lte: (b) => self.cmp(b) <= 0,
    gt: (b) => self.cmp(b) > 0,
    gte: (b) => self.cmp(b) >= 0,
    isZero: () => r.int === 0n,
    isNegative: () => r.int < 0n,
    floorToStep: (step) => {
      const s = parse(step);
      if (s.int <= 0n) throw new RangeError("step must be positive");
      const [x, y, sc] = align(r, s);
      return wrap({ int: (x / y) * y, scale: sc });
    },
    toFixed: (scale) => format(rescaleDown(r, scale), true),
    toString: () => format(r, false),
  };
  return self;
}

export function dec(a: Dec | DecimalOps): DecimalOps {
  return wrap(toRaw(a));
}

/** Number of fractional digits in a step like "0.00001000" → 8 (trailing zeros count). */
export function decScale(a: Dec): number {
  return parse(a).scale;
}

export function isDec(s: unknown): s is Dec {
  return typeof s === "string" && DEC_RE.test(s);
}
