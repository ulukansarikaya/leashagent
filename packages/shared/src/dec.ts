import type { Dec } from "./types";

const DEC_RE = /^-?\d+(\.\d+)?$/;

export function isDec(s: unknown): s is Dec {
  return typeof s === "string" && DEC_RE.test(s);
}

/** Scaled-integer representation: value = int / 10^scale. */
type Scaled = { int: bigint; scale: number };

function parse(s: Dec): Scaled {
  if (!isDec(s)) throw new Error(`invalid decimal: ${JSON.stringify(s)}`);
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [i = "0", f = ""] = body.split(".");
  const int = BigInt(i + f) * (neg ? -1n : 1n);
  return { int, scale: f.length };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function align(a: Scaled, b: Scaled): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.int * pow10(scale - a.scale), b.int * pow10(scale - b.scale), scale];
}

function format(int: bigint, scale: number): Dec {
  const neg = int < 0n;
  const abs = neg ? -int : int;
  let digits = abs.toString();
  if (scale === 0) return (neg ? "-" : "") + digits;
  digits = digits.padStart(scale + 1, "0");
  const out = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  return neg && abs !== 0n ? `-${out}` : out;
}

/** Floor division (toward -infinity) for bigint. */
function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return (a % b !== 0n && (a < 0n) !== (b < 0n)) ? q - 1n : q;
}

export interface DecimalOps {
  add(o: Dec): DecimalOps;
  sub(o: Dec): DecimalOps;
  mul(o: Dec): DecimalOps;
  /** Multiply by basis points / 10000 (exact; result keeps full precision). */
  mulBps(bps: number): DecimalOps;
  /** floor(this / o) at `scale` fractional digits. Throws on division by zero. */
  divFloor(o: Dec, scale: number): DecimalOps;
  neg(): DecimalOps;
  abs(): DecimalOps;
  cmp(o: Dec): -1 | 0 | 1;
  eq(o: Dec): boolean;
  lt(o: Dec): boolean;
  lte(o: Dec): boolean;
  gt(o: Dec): boolean;
  gte(o: Dec): boolean;
  isZero(): boolean;
  isNegative(): boolean;
  /** Round down (toward -inf) to a multiple of `step` (> 0), formatted at step's scale. */
  floorToStep(step: Dec): DecimalOps;
  /** Format at exactly `scale` fractional digits, rounding toward -inf. */
  toFixed(scale: number): Dec;
  /** Number of fractional digits as written. */
  readonly scale: number;
  toString(): Dec;
}

function make(v: Scaled): DecimalOps {
  const self: DecimalOps = {
    add: (o) => {
      const [x, y, scale] = align(v, parse(o));
      return make({ int: x + y, scale });
    },
    sub: (o) => {
      const [x, y, scale] = align(v, parse(o));
      return make({ int: x - y, scale });
    },
    mul: (o) => {
      const p = parse(o);
      return make({ int: v.int * p.int, scale: v.scale + p.scale });
    },
    mulBps: (bps) => {
      if (!Number.isInteger(bps)) throw new Error("bps must be an integer");
      return make({ int: v.int * BigInt(bps), scale: v.scale + 4 });
    },
    divFloor: (o, scale) => {
      const d = parse(o);
      if (d.int === 0n) throw new Error("division by zero");
      if (!Number.isInteger(scale) || scale < 0) throw new Error("invalid scale");
      // (A/10^sa) / (B/10^sb) = R/10^scale  =>  R = A * 10^(sb + scale) / (B * 10^sa)
      const num = v.int * pow10(d.scale + scale);
      const den = d.int * pow10(v.scale);
      return make({ int: floorDiv(num, den), scale });
    },
    neg: () => make({ int: -v.int, scale: v.scale }),
    abs: () => make({ int: v.int < 0n ? -v.int : v.int, scale: v.scale }),
    cmp: (o) => {
      const [x, y] = align(v, parse(o));
      return x < y ? -1 : x > y ? 1 : 0;
    },
    eq: (o) => self.cmp(o) === 0,
    lt: (o) => self.cmp(o) < 0,
    lte: (o) => self.cmp(o) <= 0,
    gt: (o) => self.cmp(o) > 0,
    gte: (o) => self.cmp(o) >= 0,
    isZero: () => v.int === 0n,
    isNegative: () => v.int < 0n,
    floorToStep: (step) => {
      const s = parse(step);
      if (s.int <= 0n) throw new Error("step must be > 0");
      const [x, st, scale] = align(v, s);
      return make({ int: floorDiv(x, st) * st, scale });
    },
    toFixed: (scale) => {
      if (!Number.isInteger(scale) || scale < 0) throw new Error("invalid scale");
      if (scale >= v.scale) return format(v.int * pow10(scale - v.scale), scale);
      return format(floorDiv(v.int, pow10(v.scale - scale)), scale);
    },
    scale: v.scale,
    toString: () => format(v.int, v.scale),
  };
  return self;
}

/** Decimal arithmetic on validated decimal strings. No floats anywhere. */
export function dec(a: Dec): DecimalOps {
  return make(parse(a));
}

/** Number of fractional digits of a decimal string (e.g. "0.001" -> 3). */
export function decScale(a: Dec): number {
  return parse(a).scale;
}
