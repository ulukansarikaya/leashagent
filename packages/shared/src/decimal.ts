import { dec } from "./dec.js";
import type { Dec } from "./types.js";

// Fixed-output helpers (8 fractional digits, truncated) used by agent/dashboard code.
// Thin wrappers over `dec` so there is a single decimal implementation.
const PLACES = 8;

export const decMul = (a: Dec, b: Dec): Dec => dec(a).mul(b).toFixed(PLACES);
export const decDiv = (a: Dec, b: Dec): Dec => dec(a).div(b, PLACES).toFixed(PLACES);
export const decAdd = (a: Dec, b: Dec): Dec => dec(a).add(b).toFixed(PLACES);
export const decSub = (a: Dec, b: Dec): Dec => dec(a).sub(b).toFixed(PLACES);
export const decCmp = (a: Dec, b: Dec): -1 | 0 | 1 => dec(a).cmp(b);
