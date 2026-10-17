import { keccak256, toBytes } from "viem";
import type { Hex } from "./types.js";

/** §5.5: keys alphabetical, no whitespace, UTF-8; numbers other than integers forbidden. */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "boolean": return value ? "true" : "false";
    case "number":
      if (!Number.isInteger(value)) throw new Error("canonicalJson: non-integer number forbidden");
      return String(value);
    case "object": {
      if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
      const o = value as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k])).join(",") + "}";
    }
    default: throw new Error(`canonicalJson: unsupported type ${typeof value}`);
  }
}

export function hashCanonical(value: unknown): Hex {
  return keccak256(toBytes(canonicalJson(value)));
}

export function hashText(text: string): Hex {
  return keccak256(toBytes(text));
}
