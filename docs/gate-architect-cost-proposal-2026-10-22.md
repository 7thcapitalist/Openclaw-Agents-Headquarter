# Proposta SOF-12 — reduzir o gasto de gate + architect

## Números (fonte: `docs/cost-measurement-2026-09-15.md`, ledger + replay dos rollouts, 5 dias do LifeMax)
- reviewer + qa + security = **$48.40 (49.3%)**; com architect **$73.05 (74.4%)**; builders **$20.15** (3.7 : 1).
- Replay posterior em `cost-anatomy.md`: gates+architect **$134.87** vs builders **$19.50** (~6.9 : 1; o ledger subcontava).
- Fan-out: média **2.56** despachos de gate por build; pior caso **11** (`obj-842f30eb-cost-limits-data-apis`: 9 reviewer, 1 qa, 1 security para 1 build). 264 despachos: reviewer 65 > builder 50.
- 98.3% dos tokens Claude são cache read (sessão longa relida a cada turno), output é 0.6%.
- Nota: os dois documentos divergem nos valores absolutos (métodos diferentes); a conclusão (gates dominam e são re-executados) é a mesma.

## Diagnóstico
Os gates não são caros por preço, e sim re-executados. O pior caso (9 reviewers) = exatamente 3 vereditos + 6 tentativas de infra (`maxInfraAttemptsPerStage: 6`) — cada tentativa perdida é uma sessão cheia de gate.

## Implementado (esta branch)
`stageBudgetExceeded` limita tentativas de infra de reviewer/qa/security a **4** (`GATE_MAX_INFRA_ATTEMPTS`); builder/release mantêm 6. Pior caso de uma tarefa cai de 9 para 7 sessões de reviewer (-22%), sem tocar na independência nem no critério dos gates (vereditos continuam limitados a 3). Teste: `factory/test/gate-infra-cap.test.mjs`.

## Propostas não implementadas (decisão do João)
1. **Architect**: único alvo defensável de roteamento (não é gate); rodar com modelo mais barato ou pular para tarefas de baixo risco.
2. **Contexto de sessão** do gate (maior alavanca, 98% cache read): limitar leituras/turnos por sessão.
3. Corrigir captura de uso no Codex (`agent-meta.mjs`) para medir o efeito de verdade.
