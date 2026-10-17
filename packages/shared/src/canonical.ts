import { keccak256, stringToBytes } from "viem";
import type { Hex } from "./types";

/**
 * Canonical JSON (§5.5): keys sorted, no whitespace, UTF-8.
 * Non-integer numbers are forbidden (money/prices must be Dec strings).
 * `undefined` object members are omitted; `undefined` in arrays is an error.
 */
export function canonicalJson(value: unknown): string {
  return encode(value);
}

function encode(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(v)) {
        throw new Error("canonicalJson: only safe integers are allowed as numbers");
      }
      return String(v);
    case "object": {
      if (Array.isArray(v)) {
        return `[${v
          .map((x) => {
            if (x === undefined) throw new Error("canonicalJson: undefined in array");
            return encode(x);
          })
          .join(",")}]`;
      }
      const obj = v as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(obj).sort()) {
        const val = obj[k];
        if (val === undefined) continue;
        parts.push(`${JSON.stringify(k)}:${encode(val)}`);
      }
      return `{${parts.join(",")}}`;
    }
    default:
      throw new Error(`canonicalJson: unsupported type ${typeof v}`);
  }
}

/** keccak256 over the UTF-8 bytes of canonicalJson(value). */
export function hashCanonical(value: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(value)));
}
