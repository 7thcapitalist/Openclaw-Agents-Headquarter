// Escada de recuperação, degrau 3 (VISION §3): a tarefa que falhou 2x vai para
// o João com o que foi tentado, onde travou e UMA pergunta exata.
// Pura. Só builtins.

// Lê do ledger do executor as falhas de um pedido (entradas com failure_reason).
export function failuresFor(ledgerLines, key) {
  const out = [];
  for (const line of ledgerLines) {
    try { const e = JSON.parse(line); if (e.key === key && e.failure_reason && e.status !== "blocked") out.push(e); } catch { /* linha rasgada */ }
  }
  return out;
}

export function blockMessage({ tarefa, tentativas, travouEm, pergunta }) {
  if (!pergunta || !String(pergunta).trim().endsWith("?")) throw new Error("bloqueio exige uma pergunta exata (terminada em '?')");
  if (!tentativas?.length) throw new Error("bloqueio exige o que foi tentado");
  return [
    `Bloqueada: ${tarefa}`,
    "O que tentei:",
    ...tentativas.map((t, i) => `${i + 1}. ${t}`),
    `Onde travou: ${travouEm}`,
    `Pergunta: ${String(pergunta).trim()}`,
  ].join("\n");
}
