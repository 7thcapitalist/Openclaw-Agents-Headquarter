# Runbook de recuperação (VISION §3 → executor)

A tarefa não morre: cada falha sobe um degrau; no fim ela vai para o João com a pergunta exata.

| Degrau (VISION §3) | O que acontece | Comando / estado | Onde fica registrado |
|---|---|---|---|
| 1. Falhou → nova tentativa com o erro | Pedido do inbox: falha grava `status:"failed"` + `failure_reason` + `last_log_tail`; o arquivo **fica em `inbox/`** e o próximo `processInbox` retoma só as micro-tarefas pendentes. Tarefa da fábrica: falha de infra vira `blocked` e `retryStuckTasks` retoma (até `max`=3; `maxInfraAttemptsPerStage`=6). | `processInbox` (`lib/hq/inbox-executor.mjs`); `retryStuckTasks` (`lib/hq/auto-retry.mjs`); `classifyBlocker(...)==="infra"` | linha `failed` no ledger `runs.jsonl`; evento `auto-retry` no `state.json` |
| 2. Falhou de novo → outro executor/abordagem | Trocar Codex↔Claude ou quebrar em micro-tarefas (`tarefas:` no pedido). Na fábrica: `startRecovery` → diagnóstico (Claude) → reparo verificado por outro runtime (Codex), `maxRecoveryAttempts`=3. Erro **determinístico** (conflito de merge, agente que rodou e não escreveu resultado) nunca é re-tentado igual. | `startRecovery` / `recordRecoveryResult` (`lib/task-workflow.mjs`); ver `RECOVERY_ROUTING.md` | `state.recovery.attempts[]`, eventos `recovery-*` |
| 3. Ainda bloqueada → vai para o João | `escalateRecovery` põe `status:"blocked"`, `blocker.outcome:"decision-required"`, `founderAction:true` → aparece em "Precisa de você". No Paperclip: comentário com a mensagem abaixo e status `blocked`. | `classifyBlocker(...)==="decision"`; `scripts/pedidos-status.mjs` | `state.blocker`, evento `recovery-escalated`, comentário da tarefa |

## Regra de ouro
Falhou 2x → **bloqueada** com: o que tentou, onde travou e **uma pergunta exata** (terminada em `?`, respondível com sim/não ou uma escolha). "Preciso de ajuda" não é pergunta. Dúvida vai primeiro ao CEO do estúdio; só o que é impossível sem o João (login, senha, pagamento, merge) é `human_only`. Erro de login antigo ("OAuth session expired") não é bloqueio: tente de novo.

## Mensagem de bloqueio (formato)
`blockMessage()` em `lib/hq/block-message.mjs` monta e **recusa** mensagem sem pergunta ou sem tentativas:

```
Bloqueada: Migrar o login
O que tentei:
1. codex: testes de auth falham (token expirado)
2. claude: mesmo erro no teste de auth
Onde travou: teste de auth, token de sessão expirado nas duas tentativas
Pergunta: Posso regenerar o token de teste do ambiente staging?
```

Teste (gera as 2 falhas reais no ledger e confere o texto): `node --test factory/test/block-message.test.mjs`.

## Lacuna conhecida
`escalateRecovery` hoje grava `whatItNeedsFromFounder` genérico ("Review the recorded failure and decide…"), não uma pergunta específica. A pergunta exata ainda é escrita pelo agente ao comentar/bloquear; ligar `blockMessage` ao `blocker` é um próximo passo (não feito aqui).
