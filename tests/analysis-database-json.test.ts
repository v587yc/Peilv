import { describe, expect, it } from "vitest";
import {
  parseDbJsonArray,
  parseDbJsonObject,
} from "@/features/analysis/database-json";

describe("analysis database JSON decoders", () => {
  it("accepts native arrays and JSON array strings", () => {
    const rows = [{ id: "row-1" }];

    expect(parseDbJsonArray(rows)).toEqual(rows);
    expect(parseDbJsonArray(JSON.stringify(rows))).toEqual(rows);
  });

  it("returns an empty array for absent, malformed, or non-array values", () => {
    expect(parseDbJsonArray(null)).toEqual([]);
    expect(parseDbJsonArray("")).toEqual([]);
    expect(parseDbJsonArray("{")).toEqual([]);
    expect(parseDbJsonArray('{"id":"row-1"}')).toEqual([]);
  });

  it("accepts native objects and JSON object strings", () => {
    const value = { market: "handicap" };

    expect(parseDbJsonObject(value)).toEqual(value);
    expect(parseDbJsonObject(JSON.stringify(value))).toEqual(value);
  });

  it("returns null for absent, malformed, array, or primitive values", () => {
    expect(parseDbJsonObject(null)).toBeNull();
    expect(parseDbJsonObject("{")).toBeNull();
    expect(parseDbJsonObject("[]")).toBeNull();
    expect(parseDbJsonObject(42)).toBeNull();
  });
});
