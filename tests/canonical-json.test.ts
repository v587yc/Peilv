import { describe, expect, it } from "vitest";
import { canonicalJsonSha256, stableCanonicalJson } from "@/lib/canonical-json";

const GOLDEN_CANONICAL = '{"a":[3,{"a":true,"中":"值"}],"nested":{"b":null,"😀":"雪"},"é":"原样"}';
export const GOLDEN_CANONICAL_SHA256 = "a17dc2f6709a94b5408894b94e97ac9c217e7661b2d4b9b903e9e6dbb307dc09";

describe("canonical JSON v2", () => {
  it("uses UTF-8 byte key order, preserves arrays and Unicode, and canonicalizes nested objects", () => {
    const value = { é: "原样", nested: { "😀": "雪", b: null }, a: [3, { 中: "值", a: true }] };
    expect(stableCanonicalJson(value)).toBe(GOLDEN_CANONICAL);
    expect(stableCanonicalJson(JSON.parse(GOLDEN_CANONICAL))).toBe(GOLDEN_CANONICAL);
    expect(canonicalJsonSha256(value)).toBe(GOLDEN_CANONICAL_SHA256);
  });

  it("round-trips through JSONB-equivalent parse/stringify without changing the canonical hash", () => {
    const original = { z: [{ β: 2, α: 1 }], 中文: "保留", n: 1.25 };
    const jsonbRoundTrip = JSON.parse(JSON.stringify(original));
    expect(stableCanonicalJson(jsonbRoundTrip)).toBe(stableCanonicalJson(original));
    expect(canonicalJsonSha256(jsonbRoundTrip)).toBe(canonicalJsonSha256(original));
  });

  it.each([
    ["undefined", undefined], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY],
    ["negative Infinity", Number.NEGATIVE_INFINITY], ["BigInt", BigInt(1)], ["function", () => undefined],
    ["symbol", Symbol("private")], ["nonplain Date", new Date("2026-07-18T00:00:00.000Z")],
  ])("rejects illegal %s values", (_label, value) => {
    expect(() => stableCanonicalJson({ safe: "marker", value })).toThrow(TypeError);
  });

  it("rejects cycles without exposing serialized input", () => {
    const value: Record<string, unknown> = { secret: "PAYLOAD-MUST-NOT-LEAK" };
    value.self = value;
    let error: unknown;
    try { stableCanonicalJson(value); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain("PAYLOAD-MUST-NOT-LEAK");
    expect(String(error)).not.toMatch(/[0-9a-f]{64}/);
  });
});
