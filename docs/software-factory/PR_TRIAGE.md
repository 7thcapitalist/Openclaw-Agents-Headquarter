# Triagem de PRs abertos (SOF-275)

Data: 2026-10-25 · Base: `main` @ `b295d7c` · 40 PRs abertos (`gh pr list`).

## Como foi medido
- **Mergeável?**: campo `mergeable` do GitHub contra `main`. Todos os 40 = `MERGEABLE`.
- **Conflito entre PRs**: `git merge-tree` par a par entre os PRs que não estão contidos em outro.
- **Testes**: `npm run test:factory` (o mesmo do CI; `node --test factory/test` puro quebra no Node 24) em cada PR "ponta", após `npm ci` em `dashboard/backend` e `control-plane`.
- **Resultado dos testes**: **todos os 28 PRs-ponta falham exatamente 1 teste**, sempre o mesmo:
  `factory/test/retention.test.mjs` → `--apply removes exactly the confirmed targets and nothing else`
  (`Refusing to apply: you confirmed 2 file(s) but the plan now targets 3`). Falha também na própria `main` e nos PRs de setembro, que estavam verdes na época: o problema é herdado (provável dependência de data/ambiente), não de nenhum PR. A `main` está com CI vermelho desde 2026-10-22 (#328). Todo PR do `hq/*` mostra "factory test suite: FAIL" por isso.
- Os demais ~2040 testes passam em todos.

## Bloqueio comum
Antes de mergear qualquer coisa: corrigir `retention.test.mjs` na `main` (tarefa separada). Sem isso nenhum PR fica verde.

## Tabela PR → decisão

Legenda: **PRONTO** = sem conflito com `main` nem com os outros PRONTO, só o teste herdado falha · **REBASE** = conflita com outro PR; rebase depois que o anterior entrar · **FECHAR** = commits já contidos em outro PR aberto.

| PR | Título curto | Decisão | Motivo |
|---|---|---|---|
| #359 | docs diagnóstico acpx init (SOF-267) | PRONTO | só docs, draft |
| #354 | pedidos-status tempo/quota (SOF-221) | PRONTO | independente |
| #347 | preflight (SOF-104) | PRONTO | independente |
| #334 | checklist de PR (SOF-36) | PRONTO | independente |
| #331 | teste decomposição 4 tarefas (SOF-27) | PRONTO | só teste, independente |
| #339 | resume do ledger (SOF-86) — base da cadeia inbox | PRONTO | contém #336 #337 #340; merge primeiro |
| #341 | docs/guia de quota (SOF-90) | PRONTO | empilha em #339, sem conflito com ele; ver ordem abaixo |
| #333 | relatório semanal: % verde na 1ª (SOF-34) | PRONTO | contém #330 #332; merge antes de #345/#356 |
| #326 | identidade `dot` do operador (dashboard) | PRONTO | 1665 linhas, não draft, 3 checks verdes em 10-02 → João revisa com calma |
| #325 | status canônico dos jobs (founder) | PRONTO | independente |
| #324 | verdict attribution + recovery re-verify | PRONTO | contém #320 #322 |
| #323 | seat exhaustion pausa a tarefa | PRONTO | sem conflito com #324 |
| #317 | trigger de aprendizado ocioso | PRONTO | independente |
| #315 | eventos em linguagem do founder | PRONTO | merge antes de #318 |
| #318 | painel Learning | REBASE | conflita com #315 |
| #335 | custo por gate call (SOF-79) | REBASE | conflita com toda a cadeia inbox (#339 e filhos); rebase depois de #339 |
| #342 | integração inbox→ledger (SOF-92) | REBASE | conflita com #343…#358; entrar depois de #339/#341 |
| #343 | quota_pct (SOF-93) | REBASE | idem; também toca OPERATING_RULES |
| #346 | first_pr_tests escape (SOF-97) | REBASE | idem; conflita também com #353 |
| #349 | rejeita pedido malformado (SOF-113) | REBASE | idem |
| #350 | `--status` por pedido (SOF-133) | REBASE | idem |
| #351 | total_duration_ms (SOF-218) | REBASE | idem |
| #353 | máx 4 tarefas (SOF-220) | REBASE | contém #344; idem |
| #355 | duration_ms (SOF-116) | REBASE | idem |
| #357 | review_comments (SOF-234) | REBASE | idem (a main já tem versão em commit d4b7db2: conferir se sobra algo) |
| #358 | bloqueio após 2 falhas (SOF-235) | REBASE | contém #352; idem; entrar por último |
| #345 | relatório semanal: falhas por causa (SOF-96) | REBASE | contém #338; conflita com #333 e #356 |
| #356 | fix assertion attempts (SOF-117) | REBASE | contém #348; conflita com #333 e #345 |
| #320 | verdict budgets | FECHAR | contido em #324 |
| #322 | recovery commit reverify | FECHAR | contido em #324 |
| #329 | regressão do cap de 4 retries (SOF-70) | FECHAR | contido em #335 |
| #330 | relatório semanal markdown (SOF-19) | FECHAR | contido em #333/#345/#356 |
| #332 | relatório semanal de custo (SOF-28) | FECHAR | idem |
| #336 | inbox idempotente (SOF-81) | FECHAR | contido em #339 |
| #337 | alerta de quota (SOF-82) | FECHAR | contido em #339 |
| #340 | teste gate de quota (SOF-87) | FECHAR | contido em #339 |
| #338 | custo por run no semanal (SOF-83) | FECHAR | contido em #345 |
| #344 | rejeita pedido vazio (SOF-95) | FECHAR | contido em #353 |
| #348 | regex de whitespace (SOF-107) | FECHAR | contido em #356 |
| #352 | runbook de recuperação (SOF-219) | FECHAR | contido em #358 |

Contagem: 14 PRONTO · 14 REBASE · 12 FECHAR = 40.

## Ordem sugerida de merge
1. Corrigir `retention.test.mjs` na main.
2. PRONTO independentes: #359 #354 #347 #334 #331 #325 #317 #323 #324 #315 #326.
3. Relatório semanal: #333 → rebase #345 → rebase #356.
4. Cadeia inbox: #339 → #341 → #335 → #342 → #343 → #346 → #349 → #350 → #351 → #353 → #355 → #357 → #358 (rebase de cada um sobre a main depois do anterior; todos mexem em `inbox-executor.mjs`, `factory.config.json`, `quota-alert.mjs`, `dispatch.mjs`).
5. #318 depois de #315.
6. Fechar os 12 FECHAR com o comentário "contido em #X" (nenhum foi fechado nesta tarefa).
