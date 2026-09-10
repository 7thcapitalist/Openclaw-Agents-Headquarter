// Storage, retention and backup health.
//
// Read-only. The panel can show that data is eligible for pruning; it cannot
// prune. Deleting runtime data is an operator action at the terminal, with an
// exact confirmed count — deliberately not a button, because a button is how
// "clear old files" becomes "clear the record of what the factory did".

const BACKUP_STATUS = {
  ok: ["Backed up", "status-good"],
  warning: ["Needs attention", "status-warn"],
  missing: ["Missing", "status-bad"],
  unreadable: ["Unreadable", "status-bad"],
  "not-configured": ["No backups configured", "status-warn"],
};

export function retentionPanel(source, { esc = escapeHtml } = {}) {
  if (!source) return shell("Unavailable", "status-warn", `<div class="quiet-state">Storage and backup data is not available yet.</div>`);

  const backups = source.backups || {};
  const [backupLabel, backupTone] = BACKUP_STATUS[backups.status] || BACKUP_STATUS["not-configured"];
  const totals = source.totals || {};
  const storage = source.storage || {};
  const classes = Object.entries(storage).sort((a, b) => b[1].bytes - a[1].bytes);

  return shell(backupLabel, backupTone, `
    ${source.available === false ? `<p class="operations-warning" role="status">Some storage could not be read, so these figures are incomplete.</p>` : ""}
    ${(backups.warnings || []).length ? `<ul class="permission-warnings">${backups.warnings.slice(0, 3).map((warning) => `<li>${esc(warning)}</li>`).join("")}</ul>` : ""}
    <div class="operations-metrics">
      <div><strong>${bytes(totals.bytes)}</strong><span>runtime state</span></div>
      <div><strong>${number(totals.protectedFiles)}</strong><span>protected files</span></div>
      <div><strong>${bytes(totals.eligibleBytes)}</strong><span>prunable</span></div>
      <div><strong>${backups.latest ? `${number(backups.latest.ageHours)}h` : "—"}</strong><span>newest backup</span></div>
    </div>
    <div class="retention-classes">${classes.map(([name, bucket]) => `<div class="retention-row"><div><strong>${esc(name)}</strong><span>${number(bucket.files)} file${number(bucket.files) === 1 ? "" : "s"} · ${bucket.prunable ? "prunable when old" : "never pruned"}</span></div><em>${bytes(bucket.bytes)}${bucket.eligibleFiles ? ` · ${number(bucket.eligibleFiles)} eligible` : ""}</em></div>`).join("") || `<div class="quiet-state">No runtime state recorded.</div>`}</div>
    ${backups.latest ? `<p class="operations-cost">Newest backup <strong>${esc(backups.latest.name)}</strong> · ${bytes(backups.latest.bytes)}${backups.latest.sha256 ? ` · sha256 ${esc(backups.latest.sha256.slice(0, 12))}…` : ""}</p>` : ""}
    <p class="retention-note">Pruning is an operator action at the terminal (<code>npm run factory:retention</code>) and requires an exact confirmed count. Nothing here deletes anything.</p>
  `);
}

function shell(statusLabel, statusTone, body) {
  return `<section class="founder-section retention-panel" aria-labelledby="factory-retention-title">
    <div class="section-heading"><div><span class="eyebrow">Durability</span><h2 id="factory-retention-title">Storage and backups</h2></div><span class="objective-status ${statusTone}">${statusLabel}</span></div>
    ${body}
  </section>`;
}

function bytes(value) {
  const size = Number(value) || 0;
  if (size >= 1_073_741_824) return `${(size / 1_073_741_824).toFixed(1)}GB`;
  if (size >= 1_048_576) return `${(size / 1_048_576).toFixed(1)}MB`;
  if (size >= 1024) return `${Math.round(size / 1024)}KB`;
  return `${Math.round(size)}B`;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
