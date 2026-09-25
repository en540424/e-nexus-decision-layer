# E-NEXUS Common Decision Gateway（2026-09-25・MA-30 次phase）

E-NEXUS 全体の **Decision の正式入口**。consumer（Claude Code・Cursor・Hermes・OpenAI系Agent・他LLM・各App・LINE/CRM・SNS/Growth・Worker）は
Jev も Decision Layer core も直接知らず、この Gateway の契約（Common Decision Contract v1）だけを知る。

```
Claude Code ─┐ Cursor/IDE ─┐ Hermes ─┐ OpenAI/他LLM Agent ─┐ E-NEXUS Apps / LINE / SNS / Worker ─┐
             ▼             ▼         ▼                     ▼                                    ▼
      Skill/CLI        MCP        HTTP / MCP           HTTP / MCP                           HTTP / SDK / CLI
             └─────────────┴─────────┴─────────────────────┴────────────────────────────────────┘
                                     ▼
                     Common Decision Gateway（src/gateway/gateway.mjs）
                     envelope 検証・request_id・timeout・同時実行上限・failure policy・stats
                                     ▼  DecisionEngine 契約（src/gateway/engine.mjs）
                     Decision Layer core（schema → safety → registry → router → fallback → Human Gate → metering）
                                     ▼  Adapter Interface
                     Rules → Jev（Provider: vercel / direct / cloudflare予約）→ local → llm → Human
```

## 1. 責務（何を持ち、何を持たないか）

| Gateway が持つ | Gateway が持たない（重複実装しない） |
|---|---|
| Contract v1 の envelope（`contract_version`・`request_id`・`correlation_id`・`ok`・`error`・`failure`・`gateway`） | decision_type の schema・rules・routing・fallback・confidence・Human Gate・metering（engine = Decision Layer core） |
| request_id 採番・ID 形式検証・`via`（入口面）の付与 | 承認・実行・課金・公開（常に既存の Human-only ゲート） |
| timeout（既定 30s）・同時実行上限（既定 4）・structured error・failure policy | Queue / DLQ / Automation / CRM / Monitoring 基盤 |
| process 内 stats（health 用）・入口面 4 種（SDK / CLI / HTTP / MCP） | Jev 固有の型・API 形式 |

## 2. Common Decision Contract v1

### Request

既存 `schemas/common/decision-request.schema.json` をそのまま使う（名前を複製しない）。Gateway 用に**任意**項目を追加した（後方互換）。

| field | 必須 | 意味 |
|---|---|---|
| `contract_version` | 任意 | `"1"`。他の値は `UNSUPPORTED_CONTRACT_VERSION` |
| `request_id` | 任意 | `^[A-Za-z0-9._:-]{1,128}$`。無ければ `req_<uuid>` を採番 |
| `correlation_id` | 任意 | consumer 側業務IDとの対応（例 en-generate-hub の request hash）。PII 禁止 |
| `decision_type` | 必須 | `gateway types` の一覧 |
| `application_id` | 必須 | **consumer ID**（`claude-code` / `cursor` / `hermes` / `openai-agent` / `en-generate-hub` / `line-crm` 等） |
| `project_id` | 必須 | `registries/projects.json` の id |
| `input` | 必須 | decision_type 固有 schema で検証。**engine（Jev）へ送られる**。Secret・PII・prompt 全文・ローカルパスを入れない |
| `context` | 任意 | 参照用 ID。engine へは送られない |
| `tenant` / `options` | 任意 | 既存どおり（`options.allow_paid_adapters` で高コスト LLM Adapter を opt-in） |
| `via` | — | **Gateway が設定**（consumer 指定値は上書き）。`sdk` / `cli` / `http` / `mcp` |

### Response（envelope）

```jsonc
{
  "contract_version": "1",
  "ok": true,
  "request_id": "req_…", "correlation_id": "…|null",
  "decision": { /* 既存 DecisionResult（schemas/common/decision-result.schema.json）をそのまま */ },
  "gateway": { "via": "cli", "engine": { "id": "e-nexus-decision-layer", "version": "0.1.0", "mode": "production" },
               "latency_ms": 12, "timestamp": "…" }
}
```

- consumer が読むのは `decision.outcome`（typed value）・`decision.tier`（auto / review / human）・`decision.human_gate.required`・
  `decision.confidence`・`decision.resolved_by` / `provider` / `model`・`decision.rationale`・`decision.fallback`・`decision.usage`（cost）。
  **`human_required` や `route` の別名 field は envelope に作らない**（既存名が正）。route は decision_type の outcome（例 `recommended_route`）
- `ok:false` のとき `decision` は `null`、代わりに：

```jsonc
"error":   { "code": "GATEWAY_TIMEOUT", "kind": "timeout", "retryable": true, "message": "…" },
"failure": { "policy": "human-required", "human_required": true, "proceed_automatically": false, "note": "…" }
```

| error.code | kind | retryable | HTTP |
|---|---|---|---|
| `INVALID_ENVELOPE` / `UNSUPPORTED_CONTRACT_VERSION` / `SCHEMA_INVALID` / `UNKNOWN_DECISION_TYPE` | invalid_request | false | 400 |
| `HUMAN_GATE_VIOLATION`（engine が承認キーを返そうとした。outcome は返さない） | human_gate_violation | false | 422 |
| `GATEWAY_BUSY` | busy | true | 429 |
| `GATEWAY_TIMEOUT` | timeout | true | 504 |
| `ENGINE_ERROR`（生 message は返さない） | engine_error | true | 502 |

**HTTP status は「Gateway が decision を返せたか」だけ**。`tier=human` でも 200（Decision 結果と status を混同しない）。

### Failure policy（`policies/gateway/failure-policy.json`）

値は `human-required`（既存の Human 確認・既存ゲートへ戻す）と `deny`（その処理を進めない）の **2つだけ**。fail-open は構造上存在せず、
loader がそれ以外の値を拒否する。現在の実装済み decision_type はすべて `human-required`。
例：`paid-generation-gate` で Gateway が死んだ → 「有料で進めてよい」ではなく **MA-17 の Human-only 承認チェーンを従来どおり通る**。

## 3. 承認しない（全入口共通）

`ok:true` も `tier:auto` も**許可ではない**。Decision Layer は承認キーを構造上返せず（`policies/safety/human-only.json`）、
既存 Human-only（MA-17 有料生成承認・SNS 外部公開・deploy・Secret・billing・Hub 更新ボタン等）は Gateway の外で効く。
`paid-generation-gate` で `tier:auto`・`recommended_route: en-generate-hub` はあり得る（2026-09-19 decision-log）。意味は「有料生成の**候補**として Human 承認へ進む価値がある」。

## 4. Engine mode（mock の扱い）

| mode | chain | 用途 |
|---|---|---|
| `production`（既定） | rules → jev → local → llm → human | consumer 向け。**mock-jev は入らない**。Jev が使えない環境（キー無し／`EDL_ALLOW_NETWORK`≠true）では rules で解けなければ human |
| `verification`（`--verification` / `EDL_GATEWAY_MODE=verification`） | 実 Jev が使えないときだけ mock-jev を追加 | 配管検証専用。結果の `provider:"mock"` を Jev の判断として扱わない |

既存 `createDecisionLayer()` / `cli decide` の既定（mock を入れる）は後方互換のため変えていない。consumer は Gateway を使う。

**Cost Gate 運用（§17-4 の決着）**：Gateway は利用可能なら実 Jev を既定で使う（キーと `EDL_ALLOW_NETWORK=true` がその process の env にある時）。
それが無い環境では rules → human で止まり、課金は発生しない。`EDL_ALLOW_NETWORK` を AI が勝手に true にしない（既存 CLAUDE.md）。
1 判定 ≈52 USD micros・burst 5 連続で 429 を実測済み → 同時実行上限 4・timeout 30s。

## 5. 入口面（提供面）

| 面 | 起動 | 向く consumer | 状態 |
|---|---|---|---|
| SDK | `import { createGateway } from 'e-nexus-decision-layer'` → `gateway.decide(req, { via:'sdk' })` | 同一マシンの Node（E-NEXUS Apps のサーバ側） | 実装済み |
| CLI | `node src/cli.mjs gateway decide --stdin`（`--json` / `--file` も可） | Claude Code（Skill）・shell・別 repo の Node（en-generate-hub は子 process で使用） | 実装済み・**en-generate-hub が第1実consumer** |
| HTTP | `node src/cli.mjs gateway serve [--host] [--port 8787]` | Python・Hermes・Worker・他 LLM Agent・VPS | 実装済み（local）。常駐・deploy は Human-only |
| MCP | `node src/cli.mjs gateway mcp`（stdio） | Claude Code・Cursor・MCP 対応 Agent | 実装済み。**接続（MCP 設定への登録）は Human-only**（Vault MCP接続台帳 §4-7・§5・§8-2） |

HTTP endpoints：`POST /v1/decisions`（要認証）／`GET /v1/decision-types`（要認証）／`GET /v1/health`（要認証・詳細）／`GET /health`・`GET /version`（認証不要・最小情報）。

MCP tools：`enexus_decide`・`enexus_decision_types`・`enexus_gateway_health`（Jev 名を tool 名に入れない）。legacy era（initialize）で
`2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` を交渉。modern era の `server/discover` には -32601 を返す（仕様上 legacy と判定され fallback される）。

## 6. 認証・境界（HTTP）

- 既定 bind は `127.0.0.1`。loopback 以外は `EDL_GATEWAY_TOKEN` 無しでは**起動しない**（fail-closed）
- token 設定時は `Authorization: Bearer` を sha256 digest の `timingSafeEqual` で照合。token 値は応答・ログに出さない
- `Origin` ヘッダ付き request は 403、POST の Content-Type が JSON 以外は 415（ブラウザの任意ページから localhost の有料 Jev 呼び出しを起こさせない）。body 上限 64KiB
- token の発行・投入・VPS/Mac mini/Cloud への deploy・Cloudflare Access 等の前段設定は **Human-only**

## 7. Worker（Cloudflare）と `node:fs`

Decision Layer core は schema / policy / registry を `node:fs` で読むため Workers から直接 import できない。**正式経路は HTTP Gateway**（Worker → HTTPS + service token → Gateway）とし、
core の runtime-neutral 分離は今回行わない（2026-09-25 decision-log）。理由：consumer は HTTP 契約だけを知ればよく、Worker に Jev キーを配る Secret 境界も増やさない。
公開 endpoint の常駐先（VPS / Mac mini / Cloud）と前段認証の選択は、最初の Worker consumer（crm-core `lead-triage` 等）が確定した時に Human が決める。

## 8. usage / metering / observability

- 1 判定 = `data/usage/usage.jsonl` 1 行（既存）。Gateway 経由の行は `request_id`・`correlation_id`・`via` を持つ（旧行は null として読める）
- `application_id` = consumer。`node src/cli.mjs usage --by application_id` で「誰が実際に使っているか」を確認する（「作ったが誰も使っていない」状態の検知）
- health：`gateway health`（CLI）／`GET /v1/health`／MCP `enexus_gateway_health` = version・engine mode・adapters・Jev 経路状態（キーの有無のみ）・
  process 内 counters（requests / ok / failed / fallbacks / human_tier / errors_by_code / by_decision_type / by_via / latency last・max・avg）。
  CLI は 1 process 1 判定なので、横断の件数は usage.jsonl が正

## 9. consumer の追加手順（Hermes / OpenAI / 他 LLM / LINE / SNS / Apps）

consumer 側に作るのは **consumer adapter（request を組み、envelope を読む薄い層）だけ**。core・Gateway は変更しない。

1. `application_id` を決める（例 `hermes` / `openai-agent` / `line-crm` / `en-sns-hub`）
2. 入口面を選ぶ：Node 同居 = SDK、別言語・別マシン = HTTP、MCP 対応 Agent = MCP、shell / 別 repo = CLI
3. `input` は decision_type schema の構造情報だけ（Secret・PII・本文全文を入れない）。`correlation_id` に自分の業務 ID
4. `ok:false` は必ず `failure.policy` に従う。`ok:true` でも承認ではない
5. deterministic な安全規則（consent・unsubscribe・frequency cap・公開停止等）は consumer / Growth Core 側の Rules に残し、Jev に丸投げしない
6. 新しい decision_type が要るときは architecture §7（schema + index + rules + tests）。Gateway は変えない

| consumer | 状態（2026-09-25） | 次に作るもの |
|---|---|---|
| en-generate-hub（`paid-generation-gate`） | **接続済み**（`decision-gate` コマンド・CLI transport） | — |
| Claude Code | **接続済み**（Vault Skill `enexus-decision` + CLAUDE.md の発動ルール・CLI）。MCP は Human 接続待ち | — |
| Cursor | 未接続 | MCP 設定（Human）か `.cursor/rules` で CLI |
| Hermes | 未導入（設計のみ・MA-24） | 導入時に HTTP か MCP の adapter |
| OpenAI 系 Agent / 他 LLM | consumer 未存在 | MCP（Agents SDK）か HTTP の adapter |
| LINE / CRM | 未接続（MA-31 G5-0 は触らない） | `lead-triage` schema 化の後、HTTP |
| SNS / Growth | 未接続 | note 系 Skill / en-sns-hub から `content-publish-gate` / `channel-selection` |

## 10. Engine の差し替え

- **Jev だけ替える**：Adapter / Provider の差し替え（architecture §7・§9）。Gateway・consumer は無変更
- **Decision Layer ごと替える**：`src/gateway/engine.mjs` の契約（`id` / `version` / `mode` / `decide()` / `health()`）を満たす engine を `createGateway({ engine })` に渡す。
  consumer が見る envelope の形は同一で、変わるのは `gateway.engine` だけ（`tests/gateway.test.mjs` の engine swap テスト）
