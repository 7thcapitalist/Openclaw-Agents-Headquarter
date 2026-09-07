import test from "node:test";
import assert from "node:assert/strict";
import { formatDuration } from "../lib/format-duration.mjs";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

test("formats day-scale spans at the two largest nonzero units", () => {
  assert.equal(formatDuration(2 * D + 3 * H), "2d 3h");
  assert.equal(formatDuration(2 * D + 3 * H + 45 * M + 12 * S), "2d 3h");
  assert.equal(formatDuration(1 * D), "1d");
  assert.equal(formatDuration(1 * D + 30 * S), "1d 30s");
});

test("formats hour-scale spans", () => {
  assert.equal(formatDuration(4 * H + 12 * M), "4h 12m");
  assert.equal(formatDuration(4 * H + 12 * M + 59 * S), "4h 12m");
  assert.equal(formatDuration(1 * H), "1h");
});

test("formats minute-scale spans", () => {
  assert.equal(formatDuration(5 * M + 3 * S), "5m 3s");
  assert.equal(formatDuration(5 * M), "5m");
});

test("formats second-scale spans", () => {
  assert.equal(formatDuration(45 * S), "45s");
  assert.equal(formatDuration(1 * S), "1s");
  assert.equal(formatDuration(1500), "1s");
});

test("returns 0s for zero input", () => {
  assert.equal(formatDuration(0), "0s");
});

test("returns 0s for negative input", () => {
  assert.equal(formatDuration(-1), "0s");
  assert.equal(formatDuration(-5 * H), "0s");
});

test("returns 0s for sub-second and non-finite input", () => {
  assert.equal(formatDuration(999), "0s");
  assert.equal(formatDuration(NaN), "0s");
  assert.equal(formatDuration(Infinity), "0s");
});
