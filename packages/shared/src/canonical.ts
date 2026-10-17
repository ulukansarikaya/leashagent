import { keccak256, stringToBytes } from "viem";
import type { Hex } from "./types.js";

/**
 * Canonical JSON (§5.5): object keys sorted by code unit, no whitespace, UTF-8.
 * Only strings, booleans, null, safe integers, arrays and plain objects are allowed —
 * non-integer numbers, bigint, NaN/Infinity, functions and symbols throw.
 * Object properties whose value is `undefined` are omitted (same as JSON.stringify);
 * `undefined` inside an array throws.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(v: unknown, path: string): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(v)) {
        throw new TypeError(`canonicalJson: non-integer number at ${path}; use a Dec string`);
      }
      return String(v);
    case "object": {
      if (Array.isArray(v)) {
        return "[" + v.map((x, i) => {
          if (x === undefined) throw new TypeError(`canonicalJson: undefined at ${path}[${i}]`);
          return encode(x, `${path}[${i}]`);
        }).join(",") + "]";
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`canonicalJson: non-plain object at ${path}`);
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + encode(obj[k], `${path}.${k}`)).join(",") + "}";
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof v} at ${path}`);
  }
}

/** keccak256 of the UTF-8 bytes of canonicalJson(value). */
export function hashCanonical(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)));
}

/** keccak256 of a UTF-8 string. */
export function keccakUtf8(s: string): Hex {
  return keccak256(stringToBytes(s));
}

/** Alias of keccakUtf8 (used by agent/ingest). */
export const hashText = keccakUtf8;
