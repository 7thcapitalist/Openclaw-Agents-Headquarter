# Alerta de quota por run (SOF-82 / SOF-87)

Uma página: o limite, como ler o ledger de custo e como testar o gate.

## O limite X%

Fica em `factory/factory.config.json`, bloco `quotaAlert`:

```json
"quotaAlert": { "quotaTokens": 5000000, "runWarnPct": 25 }
```

- `quotaTokens`: quota de referência, em tokens.
- `runWarnPct` (o X%): quando **uma run (task)** passa de X% de `quotaTokens`, o gate grava um evento `cost.quota-warning` em `.openclaw-factory/tasks/<task>/audit.ndjson`.
- Só dispara com consumo **estritamente maior** que X% (exatamente X% não alerta).
- Um aviso por run (`eventId` = `quota-warning:<taskId>`); rodar o gate de novo não duplica.
- Remover o bloco, ou valor <= 0 / inválido, desliga o alerta.
- Hoje: 25% de 5.000.000 = alerta acima de 1.250.000 tokens.

Código: `factory/lib/hq/quota-alert.mjs` (config e soma) e `warnIfOverQuota` em `factory/lib/telemetry/dispatch.mjs` (gate).

## Ler `cost-events.ndjson`

Arquivo: `.openclaw-factory/telemetry/cost-events.ndjson` (uma linha JSON por evento, só append).
Campos úteis: `taskId`, `eventType` (`usage`, correção ou reversão), `inputTokens`, `cachedInputTokens`, `outputTokens`, `provider`, `model`, `occurredAt`.

Tokens da run = soma de `inputTokens + cachedInputTokens + outputTokens` dos eventos `usage` do `taskId`. Percentual = tokens / `quotaTokens` × 100.

Total por task, sem dependências:

```bash
node -e "const t={};require('fs').readFileSync('.openclaw-factory/telemetry/cost-events.ndjson','utf8').split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.eventType==='usage').forEach(e=>{t[e.taskId]=(t[e.taskId]||0)+e.inputTokens+e.cachedInputTokens+e.outputTokens});console.table(t)"
```

Ver alertas já emitidos:

```bash
grep -h cost.quota-warning .openclaw-factory/tasks/*/audit.ndjson
```

(`data.pct` = % atingido, `data.limitPct` = X% configurado.)

Detalhes do ledger: `PAPERCLIP_COST_LEDGER.md`.

## Rodar o teste de integração

`factory/test/quota-gate-integration.test.mjs` grava eventos sintéticos no ledger (quota 10.000, X=25 → limite 2.500 tokens), roda o gate e confere o audit. Cobre: alerta acima de X%, sem duplicar, sem alerta abaixo/exatamente em X%, e sem contar tokens de outra task.

```bash
node --test factory/test/quota-gate-integration.test.mjs   # só este
npm run test:factory                                       # suíte completa
```
