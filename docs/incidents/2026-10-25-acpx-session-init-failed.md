# acpx_session_init_failed ("Internal error") — diagnóstico (SOF-267)

Data: 2026-10-25. Fonte: `GET /api/companies/<id>/heartbeat-runs?limit=1000` (empresa e07e62a0, 856 runs desde 2026-10-20) + `holding-hq/ledger/runs.jsonl` linhas 109-110 + `scripts/claude-slot-agents.mjs`.
Limite: só a empresa e07e62a0 foi consultada (as demais empresas negaram acesso com a chave deste agente); a contagem é piso, não total.

## Contagem (semana 20–25/10)
**29 runs** com `errorCode=acpx_session_init_failed` (3,4% das 856 runs; 5.º código de erro mais comum, atrás de issue_reassigned, cancelled, provider_quota).

| Surto | Janela (UTC) | Runs | Mensagem |
|---|---|---|---|
| A | 23/10 19:27–19:29 | 6 | "Internal error" (3) e "ACP agent disconnected" (3; um com `exit=3221226505` = 0xC0000409) |
| B | 24/10 06:45 | 1 | "Internal error" |
| C | 25/10 21:11–21:18 | 22 | "Internal error" |

Run ids:
- A: d4674df4-415f-4cc1-86d9-f4dd9a873c04, 0970d04f-6b1c-4a9a-a83a-0f08a90cfc8a, 8ceb21cb-2ddd-4f37-b8c6-f4baace02bcd, a6c7d789-cda6-4326-9d32-7d158261e46b, e449e457-122d-4ee0-a90e-61e957dfd3f2, f7623c5c-c748-4e02-9b49-f90fd2f2802f
- B: 5779f6bc-2bbc-480b-8015-11295e8fec09
- C: e6ae2b24-d7c7-418c-ab81-1f26a56b742b, 6f22cf02-4a62-4dbc-b9bf-30f8df18fb90, 3d7f8208-f70b-4f2b-839f-cb6fe1ecfa06, 78c21d74-b385-4685-9149-ee076ed2516c, 16dc17b0-de85-4ae4-a894-6551c96cef91, 92c8db51-eb4b-4178-ba95-1910b50871e1, 42e979ba-5c09-4865-9d1e-5a58ebd90109, b43e8df3-a7a2-4b69-828d-d48060a9694a, c29bddf6-9b5a-4248-b5d2-b719454e4bd8, afb5e886-f543-47ba-b717-c07a5efb921a, 49fe5178-bc23-4c24-b19a-2f4892adb2dc, b6af5610-97eb-4e1c-9080-a36fc8b6b50a, 7eecc8c2-7781-4279-b4f7-248fc7b7114a, 308a995b-12af-4bd2-94f0-f58b89c98f71, c95e535b-ea34-4755-88a1-072a469c4ade, 5ece00d0-d0bc-428d-b9e7-94594473523f, 18b5e4db-802d-4915-b0bb-74447be31250, c6f32991-15ab-4445-9bb3-297a066e439c, 3da4a721-a5f9-47a5-92ed-fa013db00ef4, 690ef42c-7955-4e49-b2bf-1a6c2c1766ff (SOF-205), 35696e6f-03e0-4bf2-9fc4-1998ec1814bd, d6d64f55-df6b-4f63-aa20-f4d9bcc79ea0

## Causa provável
- **Surto C (22 de 29, 76%): porteiro `claude-slot.mjs`.** `claude-slot-agents.mjs` apontou `CLAUDE_CODE_EXECUTABLE` dos agentes para `scripts/claude-slot.mjs`. O ACPX tenta executar esse caminho como binário; um `.mjs` não é executável no Windows (sem `node` na frente), então a sessão nem inicia → "Internal error". Evidência: primeira falha 21:11, última 21:18:42; o Gerente rodou `--off` (commit bb513ab, 21:21) e o run 7b054e32 voltou a `succeeded` às 21:21 (ledger linha 110, HOL-71/HOL-73). Cada issue era retentada a cada ~2 s (5 issues × 3 tentativas em 21:11–21:12), o que queimou os 2 runs da rotina SOF-205 e a deixou `blocked` em ~1 min.
- **Surtos A e B (7 de 29): sobrecarga da máquina, não quota.** "disconnected (connection_close/process_exit)" e exit 0xC0000409 indicam o processo ACP morrendo. O ledger (linha 89, 25/10) registra a máquina saturada: 0,3 GB livres de 15,3 GB, ~8 runs simultâneas, cada uma subindo MCPs via `npx @latest`. Hipótese; não foi confirmado com logs de memória do horário de A/B.
- **Quota Claude descartada:** quota esgotada aparece como `provider_quota` (35 runs, código separado), nunca como `acpx_session_init_failed`.

## Correção proposta
1. **Já feito:** `claude-slot-agents.mjs --off` (usar o `claude.exe` direto). Não reativar o porteiro como `.mjs`.
2. Se o teto de concorrência ainda for desejado: o porteiro precisa ser um executável real (`claude-slot.cmd` que chama `node claude-slot.mjs %*`, ou `.exe` empacotado) **e** ser testado com 1 run de um agente antes de aplicar em todos (`claude-slot-agents.mjs <prefixo-do-agente>` já aceita 1 agente). Sem esse teste, não aplicar em massa.
3. **Retry com espera:** para `acpx_session_init_failed`, a nova tentativa deve esperar ≥60 s (backoff) em vez de ~2 s, e a rotina não deve ir a `blocked` antes de 3 falhas espaçadas. Isto é configuração/código do Paperclip (fora deste repo); recomendação para o Gerente da Holding.
4. **Alarme:** ≥3 `acpx_session_init_failed` em 5 min → o Gerente reverte a última mudança de `CLAUDE_CODE_EXECUTABLE` (`--off`). Teria encurtado o surto C de ~7 min para ~1.
5. Surtos A/B: manter o limite de runs simultâneas e retirar `@latest` dos MCPs (fixar versão) para reduzir pico de memória.

## Validação pendente
Medir de novo em 7 dias: meta = 0 ocorrências do tipo do surto C; A/B ≤1 por semana.
