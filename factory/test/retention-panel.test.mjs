import test from "node:test";
import assert from "node:assert/strict";
import { retentionPanel } from "../../dashboard/backend/public/lib/retentionView.mjs";

const snapshot = (over = {}) => ({
  version: 1, available: true, warnings: [], destructiveActionsRequireOperator: true,
  storage: {
    canonical: { files: 47, bytes: 992_000, eligibleFiles: 0, eligibleBytes: 0, prunable: false },
    ephemeral: { files: 316, bytes: 1_432_000, eligibleFiles: 12, eligibleBytes: 60_000, prunable: true },
  },
  totals: { files: 407, bytes: 2_584_802, eligibleFiles: 12, eligibleBytes: 60_000, protectedFiles: 57 },
  backups: {
    version: 1, configured: true, status: "ok", backupDir: "/var/backups/hq", maxAgeHours: 24,
    latest: { name: "hq-2026-09-09.tar.gz", bytes: 12_000_000, mtime: "2026-09-09T23:00:00Z", ageHours: 5, sha256: "a".repeat(64) },
    backups: 7, bytes: 84_000_000, lastFailure: null, warnings: [],
  },
  ...over,
});

test("renders an honest unavailable state", () => {
  assert.match(retentionPanel(null), /Unavailable/);
});

test("the header leads with backup status, because that is the durability question", () => {
  assert.match(retentionPanel(snapshot()), /Backed up/);
  assert.match(retentionPanel(snapshot({ backups: { status: "not-configured", warnings: ["No backup directory is configured."] } })), /No backups configured/);
  assert.match(retentionPanel(snapshot({ backups: { status: "missing", warnings: [] } })), /Missing/);
});

test("protected files are counted as prominently as prunable ones", () => {
  const html = retentionPanel(snapshot());
  assert.match(html, /57/);
  assert.match(html, /protected files/);
});

test("each class says whether it can ever be pruned", () => {
  const html = retentionPanel(snapshot());
  assert.match(html, /canonical/);
  assert.match(html, /never pruned/);
  assert.match(html, /prunable when old/);
  assert.match(html, /12 eligible/);
});

test("backup warnings are surfaced, not summarised away", () => {
  const html = retentionPanel(snapshot({
    backups: { ...snapshot().backups, status: "warning", warnings: ["Latest backup is 72h old, past the 24h bound.", "Backup failure marker present: upload failed"] },
  }));
  assert.match(html, /Needs attention/);
  assert.match(html, /past the 24h bound/);
  assert.match(html, /upload failed/);
});

test("the newest backup is shown with its integrity hash", () => {
  const html = retentionPanel(snapshot());
  assert.match(html, /hq-2026-09-09\.tar\.gz/);
  assert.match(html, /sha256 aaaaaaaaaaaa…/);
});

test("the panel offers no way to delete anything, and says where deletion lives", () => {
  const html = retentionPanel(snapshot());
  assert.doesNotMatch(html, /<button/, "a prune button is how 'clear old files' becomes 'clear the record'");
  assert.doesNotMatch(html, /<form/);
  assert.match(html, /npm run factory:retention/);
  assert.match(html, /Nothing here deletes anything/);
});

test("degraded storage is labelled", () => {
  assert.match(retentionPanel(snapshot({ available: false })), /figures are incomplete/);
});

test("backup names and warnings are escaped", () => {
  const html = retentionPanel(snapshot({
    backups: { ...snapshot().backups, status: "warning", warnings: ["<script>alert(1)</script>"], latest: { ...snapshot().backups.latest, name: "<img src=x>" } },
  }));
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x>/);
});

test("the panel styles its own note rather than borrowing another panel's class", () => {
  // Borrowing a class defined by a different panel renders unstyled until that
  // panel merges, and restyles silently if it changes.
  const html = retentionPanel(snapshot());
  assert.match(html, /class="retention-note"/);
  assert.doesNotMatch(html, /decision-authority/);
});

test("the panel carries an accessible section label", () => {
  assert.match(retentionPanel(snapshot()), /aria-labelledby="factory-retention-title"/);
});
