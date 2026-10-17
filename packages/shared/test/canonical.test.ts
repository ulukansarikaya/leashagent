import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical } from "../src";

describe("canonicalJson", () => {
  it("sorts keys, no whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: "x", c: [2, 1] } })).toBe('{"a":{"c":[2,1],"d":"x"},"b":1}');
  });

  it("is key-order independent", () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(hashCanonical({ a: 1, b: 2 })).toBe(hashCanonical({ b: 2, a: 1 }));
  });

  it("omits undefined members, rejects undefined in arrays", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(() => canonicalJson([undefined])).toThrow();
  });

  it("forbids non-integer numbers and unsupported types", () => {
    expect(() => canonicalJson({ p: 1.5 })).toThrow();
    expect(() => canonicalJson({ p: NaN })).toThrow();
    expect(() => canonicalJson({ p: 10n })).toThrow();
  });

  it("allows booleans and null; handles unicode", () => {
    expect(canonicalJson({ t: true, n: null, s: "ş" })).toBe('{"n":null,"s":"ş","t":true}');
  });

  it("hash is 32-byte hex and value-sensitive", () => {
    const h = hashCanonical({ a: "1" });
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h).not.toBe(hashCanonical({ a: "2" }));
  });
});
