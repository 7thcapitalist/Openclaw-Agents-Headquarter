export const NO_VERDICT_LITERALS = Object.freeze([
  "could not start the CLI",
  "wrote no result file",
  "did not write its result file",
  "could not run",
]);

// Match only the four contract phrases. In particular, do not use attempt
// number, outcome, infraFailure, or the workflow engine's broader infra regex.
export function isNoVerdictContent(content) {
  const text = String(content || "").toLowerCase();
  return NO_VERDICT_LITERALS.some((literal) => text.includes(literal.toLowerCase()));
}
