import type { BinaryProbabilities, ProbabilityResult, ThreeWayProbabilities } from "./types";

export interface OneXTwoOdds {
  home: number;
  draw: number;
  away: number;
}

export interface BinaryOdds {
  first: number;
  second: number;
}

function validOdd(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function devigOneXTwo(odds: OneXTwoOdds): ProbabilityResult<ThreeWayProbabilities> {
  if (![odds.home, odds.draw, odds.away].every(validOdd)) {
    return { quality: "invalid_odds", value: null, reason: "1X2 odds must be finite positive numbers" };
  }
  const raw = [1 / odds.home, 1 / odds.draw, 1 / odds.away];
  const total = raw[0] + raw[1] + raw[2];
  if (!Number.isFinite(total) || total <= 0) {
    return { quality: "invalid_odds", value: null, reason: "1X2 implied probability is invalid" };
  }
  return {
    quality: "available",
    value: { home: raw[0] / total, draw: raw[1] / total, away: raw[2] / total },
  };
}

export function devigBinary(odds: BinaryOdds): ProbabilityResult<BinaryProbabilities> {
  if (![odds.first, odds.second].every(validOdd)) {
    return { quality: "invalid_odds", value: null, reason: "Binary odds must be finite positive numbers" };
  }
  const first = 1 / odds.first;
  const second = 1 / odds.second;
  const total = first + second;
  if (!Number.isFinite(total) || total <= 0) {
    return { quality: "invalid_odds", value: null, reason: "Binary implied probability is invalid" };
  }
  return { quality: "available", value: { first: first / total, second: second / total } };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function aggregateOneXTwoOdds(books: readonly OneXTwoOdds[]): ProbabilityResult<ThreeWayProbabilities> {
  if (books.length === 0) return { quality: "insufficient_data", value: null, reason: "No 1X2 companies supplied" };
  const results = books.map(devigOneXTwo);
  const invalid = results.find(result => result.value === null);
  if (invalid) return { quality: invalid.quality, value: null, reason: invalid.reason };
  const values = results.map(result => result.value!);
  const medians = [median(values.map(v => v.home)), median(values.map(v => v.draw)), median(values.map(v => v.away))];
  const sum = medians[0] + medians[1] + medians[2];
  return { quality: "available", value: { home: medians[0] / sum, draw: medians[1] / sum, away: medians[2] / sum } };
}

export function aggregateBinary(books: readonly BinaryOdds[]): ProbabilityResult<BinaryProbabilities> {
  if (books.length === 0) return { quality: "insufficient_data", value: null, reason: "No binary-market companies supplied" };
  const results = books.map(devigBinary);
  const invalid = results.find(result => result.value === null);
  if (invalid) return { quality: invalid.quality, value: null, reason: invalid.reason };
  const first = median(results.map(result => result.value!.first));
  return { quality: "available", value: { first, second: 1 - first } };
}
