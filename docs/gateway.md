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
| `environment` | — | **Gateway が runtime 設定から設定**（consumer 指定値は上書き）。`dev` / `staging` / `production`（2026-09-26・§12） |
| `expected_environment` | 任意 | consumer が想定する環境の宣言（envelope 項目。engine へは渡らない）。runtime と違えば `ENVIRONMENT_MISMATCH`（§12） |

### Response（envelope）

```jsonc
{
  "contract_version": "1",
  "ok": true,
  "request_id": "req_…", "correlation_id": "…|null",
  "decision": { /* 既存 DecisionResult（schemas/common/decision-result.schema.json）をそのまま */ },
  "gateway": { "via": "cli", "environment": "dev", "engine": { "id": "e-nexus-decision-layer", "version": "0.1.0", "mode": "production" },
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
| `ENVIRONMENT_MISMATCH`（`expected_environment` ≠ runtime environment。engine を呼ばない・usage に書かない。§12） | environment_mismatch | false | 409 |
| `GATEWAY_BUSY` | busy | true | 429 |
| `GATEWAY_TIMEOUT` | timeout | true | 504 |
| `ENGINE_ERROR`（生 message は返さない） | engine_error | true | 502 |

**HTTP status は「Gateway が decision を返せたか」だけ**。`tier=human` でも 200（Decision 結果と status を混同しない）。

**timeout の既知の制約**：`GATEWAY_TIMEOUT` を返した後も engine の `decide()` は中断されず走り続ける（Jev 呼び出しが完了して usage.jsonl に1行書かれることがあり、同時実行カウントはその時点で解放済み）。consumer への結果は fail-closed のままなので安全側だが、長時間ハングが続く環境では同時実行上限を実質超え得る。別 process の consumer（en-generate-hub）は Gateway の 30s より長い 35s で子 process を止め、Gateway 側の構造化 envelope を先に受け取れるようにしている。

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

- 1 判定 = `data/usage/usage.jsonl` 1 行（既存）。Gateway 経由の行は `request_id`・`correlation_id`・`via`・`environment`（2026-09-26〜）を持つ（旧行は null として読める）
- usage の既定の置き場所は環境で分かれる：`dev`＝従来どおり `data/usage/usage.jsonl`、`staging` / `production`＝`data/usage/<environment>/usage.jsonl`（`EDL_USAGE_PATH` があればそれが優先。§12）
- `application_id` = consumer。`node src/cli.mjs usage --by application_id` で「誰が実際に使っているか」を確認する（「作ったが誰も使っていない」状態の検知）
- health：`gateway health`（CLI）／`GET /v1/health`／MCP `enexus_gateway_health` = version・engine mode・adapters・Jev 経路状態（キーの有無のみ）・
  process 内 counters（requests / ok / failed / fallbacks / human_tier / errors_by_code / by_decision_type / by_via / latency last・max・avg）。
  CLI は 1 process 1 判定なので、横断の件数は usage.jsonl が正

## 9. consumer の追加手順（Consumer Integration 標準・2026-09-26 改訂）

新しい App / SaaS / Agent（Hermes・OpenAI 系 Agent・他 LLM・LINE / CRM・SNS・各 App）を Gateway へつなぐとき、
consumer 側に作るのは **thin consumer adapter（request を組み、Gateway を呼び、envelope を読む薄い層）だけ**。core・Gateway は変更しない。
2026-09-26 の OpenMontage 接続では Gateway・core・schema の変更は 0 行だった（adapter と test だけで接続できた）。

### 9-1. 既存 3 consumer の比較から固定した共通責務

| 責務 | Claude Code（Skill `enexus-decision`） | en-generate-hub（`decision-gate`） | en-sns-hub（`src/growth-decision.mjs`） | 標準 |
|---|---|---|---|---|
| consumer ID | `application_id: claude-code` | `en-generate-hub` | `en-sns-hub` | 固定の `application_id` を 1 つ持つ（中央 registry は無い。`usage --by application_id` で可視化） |
| transport | CLI（Skill の手順で `gateway decide --stdin`） | CLI 子 process | CLI 子 process | request は stdin（argv に載せない） |
| 子 process の env | Claude Code の env を継承 | allowlist（OS + `EDL_*` + engine-env manifest）・`FAL_`/`WAVESPEED_` 除外 | 同じ allowlist・`ANTHROPIC_` 等除外 | allowlist ＋ consumer 自身の Secret 除外（§11-2） |
| timeout | Gateway 既定 30s | 35s | 35s | consumer 側は Gateway より長く（35s） |
| 失敗時 | `failure.policy` に従う | fail-closed envelope を local で組む | 同じ | throw せず fail-closed（human-required）の envelope |
| envelope 検証 | 手順で確認 | `contract_version`・`ok` の形 | 同じ＋environment 照合 | 形・`decision` の有無・`gateway.environment` |
| 環境 | `expected_environment: dev`（2026-09-26〜） | `expected_environment: dev`（2026-09-26〜） | `expected_environment: dev`・非 dev は接続しない | local CLI / SDK は `dev` のみ（§12） |
| correlation | 任意 | `en-generate-hub:<request hash>` | `en-sns-hub:<content_id>` | PII を含まない業務 ID（hash 可） |
| Engine 固有名 | 持たない | 持たない（2026-09-26 に除去） | 持たない | consumer は Jev 等の env 名・endpoint・provider を持たない |
| Human-only | 判定は承認ではない | MA-17 承認チェーンと分離（test で import を禁止） | `publication: human-only` 固定 | 結果に承認・実行キーを持たせない／`proceed_automatically:false` |

en-generate-hub と en-sns-hub の transport 部分（`resolveEdlHome`・`loadEngineEnvSpec`・`buildChildEnv`・`unavailableEnvelope`・`callDecisionGateway`）は
ほぼ同じコードの重複だった。これを `consumer-kit/node/cli-transport.mjs` として抽出した（既存 2 consumer の移行は §9-5）。

### 9-2. 共通化しないもの（consumer 固有に残す）

- **Decision Point の検出**（Claude Code：Skill の発動条件／en-generate-hub：`decision-gate` コマンド／SNS：候補生成後／OpenMontage：有料 tool の直前）
- **input builder**（生成要求 → `paid-generation-gate`、Threads 候補 → GrowthCandidate → `channel-selection`・`content-publish-gate` 等）。
  何を送り何を伏せるかは consumer の業務データに依存する
- **outcome の正規化と表示**（日本語の次段階表示・ブラウザへの返却形等）
- **consumer 自身の Secret 名**（`neverForward`）と deterministic な安全規則（consent・frequency cap・公開停止等は consumer / Growth Core 側の Rules）

### 9-3. 標準手順（新 consumer ごとに再発明しない）

1. **identity**：`application_id` を決める（例 `hermes` / `openai-agent` / `line-crm` / `openmontage`）。`project_id` は `registries/projects.json` の id
2. **environment**：どの実行環境の Gateway につなぐかを先に決める（§12）。本人用・内部用＝`dev`。一般販売・外部ユーザー向けは `production` 前提で
   **今の DEV Gateway へつながない**（Production Gateway は未構築＝接続先・Secret・deploy は Human Required）。不明なら Production へ推測接続しない
3. **Decision Point**：どの時点で呼ぶかを 1〜2 箇所に絞る（全操作に通さない）
4. **decision_type**：`gateway types` の既存 type を使う。無ければ architecture §7（schema + index + rules + tests）。consumer が未知の type を作らない
5. **structured context**：`input` は decision_type schema の構造情報だけ。参照用 ID は `context`（engine へ送られない）。`correlation_id` に PII の無い業務 ID
6. **PII / Secret boundary**：`input` に Secret・PII・人物名・prompt / 本文の全文・ローカルパスを入れない。疑いがあれば本文を送らない（rules で止める）
7. **Gateway 呼び出し**：入口面を選ぶ（Node 同居 = SDK、shell / 別 repo = CLI、別言語・別マシン = HTTP、MCP 対応 Agent = MCP）。CLI は §9-4 の transport 契約に従う
8. **typed result 検証**：`contract_version`・`ok`・`decision` の有無・`gateway.environment` を確認し、`decision.outcome` / `tier` / `human_gate` を読む
9. **Human-only 境界**：`ok:true`・`tier:auto` でも承認ではない。結果に承認・実行キーを作らない。有料実行・公開・送信・deploy は既存 Human-only ゲートを通る
10. **failure / mismatch**：`ok:false` は `failure.policy`（human-required / deny）に従う。環境不一致・欠落・Gateway 不在・timeout・不正応答は fail-closed。自動 retry・自動続行しない
11. **usage evidence**：`usage --by application_id` と `scripts/real-jev-evidence.mjs --expect <application_id>` で「実際に使われている」ことを確認できる（§11-3）
12. **tests**：transport は `consumer-kit/conformance/transport-cases.json` を全件通す。consumer 固有部分は builder（送らない情報）・解釈（承認でない・不明 route は human）を test
13. **real smoke**：synthetic input で 1〜2 回（burst 429 実測あり）。事前に `gateway health` で経路を確認し、事後に `--since` と `request_id` を照合（§11-4）
14. **SSOT / Product Hub / log**：この表（§9-5）・Vault Decision Layer 正本 §18・アプリ別技術スタック台帳・開発ログ。Product Hub は事業イベントがある時だけ
15. **commit / push**：consumer repo と Gateway repo を別々に。remote の無い repo は commit まで

### 9-4. transport 契約と Consumer Integration Kit（`consumer-kit/`）

local CLI transport（`gateway decide --stdin` を子 process で呼ぶ）の契約：

- request は stdin・`contract_version: "1"`・`expected_environment: "dev"`（local CLI / SDK は DEV のみ。staging / production 指定は Gateway を呼ばずに fail-closed）
- 子 process の env は OS の最低限 + `EDL_*` + `policies/gateway/engine-env.json` の名前だけ。consumer 自身の Secret は manifest に関係なく渡さない
- timeout 35s。起動失敗・timeout・非 JSON・非 v1・`ok:true` で `decision` 無し・`gateway.environment` 不一致 / 欠落は fail-closed（human-required）の envelope
- Gateway 自身の `ok:false` は `failure.policy` ごとそのまま渡す。stderr は表示・保存しない

| Kit の部品 | 用途 |
|---|---|
| `consumer-kit/conformance/transport-cases.json` | 上の契約の言語非依存 cases（Gateway 応答 10 件・echo・env allowlist 3 profile・設定不備 4 件） |
| `consumer-kit/conformance/fake-gateway/` | cases を返す fake Gateway（`EDL_HOME` に指定・`EDL_FAKE_CASE` で選択）。通信・書き込みなし |
| `consumer-kit/node/cli-transport.mjs` | Node reference transport（`createCliTransport({ neverForward, environment })`）。新 Node consumer はコピーして持つ |
| `integrations/openmontage/enexus_openmontage_decision.py` | Python の実装例（同じ cases を通す）。2 つ目の Python consumer が出たら transport 部分を kit へ移す |

repo をまたぐ runtime import はしない（consumer の Secret を Gateway repo のコードへ見せないため・version 結合を作らないため）。
HTTP / Production 用 transport は Production Gateway の構築（Human-only）と同時に作る。Kit に Decision Engine 固有の名前は入れない（`tests/consumer-kit.test.mjs` が検査）。

### 9-5. consumer 一覧

| consumer | 状態（2026-09-26） | 次に作るもの |
|---|---|---|
| en-generate-hub（`paid-generation-gate`） | **接続済み**（`decision-gate`・CLI transport）。2026-09-26 実 Jev 到達確認。同日 `expected_environment: dev` と environment 照合を追加（標準準拠） | transport を `consumer-kit/node/cli-transport.mjs` へ寄せるのは任意（次に触る時） |
| Claude Code | **接続済み**（Vault Skill `enexus-decision` + CLAUDE.md の発動ルール・CLI）。2026-09-26 実 Jev 到達確認。同日 Skill の request に `expected_environment: dev` を追加。MCP は Human 接続待ち | — |
| SNS / Growth（`channel-selection`・`content-publish-gate`） | **接続済み（2026-09-26・dev）**：en-sns-hub `src/growth-decision.mjs`（thin adapter・CLI transport・`expected_environment: dev`）＋ `POST /api/decide`。実 Jev 到達確認 | Worker 版は HTTP Gateway が要る（deploy は Human-only）。transport の kit 移行は任意 |
| **OpenMontage（`paid-generation-gate`）** | **接続済み（2026-09-26・dev）**：`integrations/openmontage/enexus_openmontage_decision.py`（Python thin adapter・CLI transport・`application_id: openmontage`）。route=en-generate-hub は /en-generate（MA-17）への引き継ぎ候補で、OpenMontage 内蔵の有料 tool は使わない。実 Jev 到達確認 | OpenMontage の agent 手順（上流 `AGENT_GUIDE.md`）へは組み込まない（上流 clone は編集しない）。呼び出しは Claude Code Skill `enexus-decision` の案内から |
| Cursor | 未接続 | MCP 設定（Human）か `.cursor/rules` で CLI |
| Hermes | 未導入（設計のみ・MA-24） | 導入時に HTTP か MCP の adapter（Python なら openmontage adapter の transport を kit へ移して使う） |
| OpenAI 系 Agent / 他 LLM | consumer 未存在 | MCP（Agents SDK）か HTTP の adapter |
| LINE / CRM | 未接続（MA-31 G5-0 は触らない） | `lead-triage` schema 化の後、HTTP |
| 一般販売 App / SaaS（AI Cost Manager・旅レートカメラ・足場 SaaS 等） | 未接続 | **Production Backend → Production Gateway**（未構築・Human Required）。client に Secret を置かない。DEV Gateway へつながない（§12） |

## 10. Engine の差し替え

- **Jev だけ替える**：Adapter / Provider の差し替え（architecture §7・§9）と `policies/gateway/engine-env.json`（engine が読む env 名）の更新。Gateway・consumer は無変更
- **Decision Layer ごと替える**：`src/gateway/engine.mjs` の契約（`id` / `version` / `mode` / `decide()` / `health()`）を満たす engine を `createGateway({ engine })` に渡す。
  consumer が見る envelope の形は同一で、変わるのは `gateway.engine` だけ（`tests/gateway.test.mjs` の engine swap テスト）

## 11. 実 Jev 経路の有効化と証跡（2026-09-26・MA-30 実JEV第1段）

### 11-1. 有効化条件（現行コードが正）

| env | 値 | 読む場所 |
|---|---|---|
| `EDL_ALLOW_NETWORK` | `true` | jev-adapter / 各 Provider（二重チェック）。これが無いと送信前に `NETWORK_DISABLED` |
| `JEV_PROVIDER` | `vercel` | provider 選択（未設定は `direct`＝TypeSafe 招待待ちなので `JEV_API_KEY_MISSING` で止まる） |
| `AI_GATEWAY_API_KEY` | （Secret。Human のみが設定） | vercel provider。無いと `JEV_VERCEL_API_KEY_MISSING` |
| 任意：`JEV_VERCEL_MODEL`（既定 `typesafe-ai/jev`）・`JEV_ZDR`・`AI_GATEWAY_BASE_URL` | | vercel provider |

- 3 つが **Gateway を起動する process の env** に揃ったときだけ実 Jev へ送る。CLI は `.env` を読まない。AI は設定しない（CLAUDE.md）
- `gateway health` の `engine_health.jev` = `{ provider, network_enabled, usable, reason }`（キーの有無のみ）。`usable:true` が前提条件
- timeout 30s・同時実行 4（§4）。AI SDK が 408/409/429/5xx を最大 2 回 retry（2s→4s）。失敗は reason 語彙（`JEV_RATE_LIMITED` / `JEV_OVERLOADED` / `JEV_NETWORK_ERROR` / `JEV_MALFORMED_RESPONSE` 等）で attempts[] に残り、human へ倒れる（`tests/gateway-real-jev-path.test.mjs`）

### 11-2. consumer へ渡す env は engine-env manifest が決める

別 process で Gateway CLI を起動する consumer（en-generate-hub 等）は、子 process に **OS 基本 + `EDL_*` + `policies/gateway/engine-env.json` の名前** だけを渡す。
consumer は Jev 固有の env 名（`JEV_*` / `AI_GATEWAY_*`）をコードに持たない。engine を替えるときはこの manifest だけ変える。
manifest が読めない consumer は `EDL_*` だけを渡す（外部判断経路が使えず human へ倒れる＝fail-closed）。
`tests/gateway-engine-env.test.mjs` が「src が読む env 名をすべて manifest が網羅している」ことを検査する。Claude Code（Skill → CLI）は Claude Code process の env をそのまま継承する。

### 11-3. 「実 Jev を使った」の判定

`resolved_by` では判定しない（実 Jev が正常応答しても confidence が閾値未満なら `tier:human`・`resolved_by:human` になる）。
usage.jsonl の行の `attempts[]` に **`adapter=jev`・`status=ok`・`networked=true`・`route` が実経路（`vercel` / `direct`）・`input_tokens>0`** があれば実 Jev 証跡。

```bash
node scripts/real-jev-evidence.mjs --since <smoke開始のISO時刻> --expect claude-code,en-generate-hub   # 両 consumer に証跡が無ければ exit 1
```

### 11-4. smoke 手順（Human が env を設定した後。有料生成・公開・production mutation はしない）

1. `node src/cli.mjs gateway health` → `jev.usable: true`・`provider: vercel`
2. Claude Code consumer：Skill `enexus-decision` の手順どおり `application_id:"claude-code"` の `channel-selection`（無害な架空 dev-log × note・未公開）を `gateway decide --stdin`
3. en-generate consumer：en-generate-hub で `node src/cli.mjs decision-gate --input <request.json> --json`（MA-17 承認の手前で止まる。run / approve / submit はしない）。`purpose` は Jev へ送られるので、smoke では既存 example を scratchpad へコピーし、`purpose` を人名・固有の人物設定を含まない短い架空の説明に差し替えて使う
4. 任意：`gateway serve`（loopback・一時起動）へ `POST /v1/decisions` を 1 回（`application_id:"http-smoke"`）→ 停止
5. `scripts/real-jev-evidence.mjs --since … --expect claude-code,en-generate-hub` で証跡確認し、表示された `request_id` が手順 2・3 の envelope の `request_id` と一致することを照合する（`--since` と `application_id` だけで判定しない）。`field_confidence` は runner 外では attempt に残らないので、limiting field の確認が要るときは `scripts/poc-calibration.mjs` を使う

tests は実 Jev を呼ばない（decision-layer は明示 env `{}`・一時 usage、en-generate-hub は env を継承しても `EDL_HOME` を fake Gateway に向ける）。User scope に実 JEV 用 env を置いても `npm test` は実 Jev を呼ばず、本番 usage.jsonl にも書かない。

### 11-5. Jev の判定と MA-17 承認は別の層

`paid-generation-gate` の Jev 判定は「Local / 無料で足りるか・有料候補か・Human review が要るか・route 候補」まで。
`tier:auto` でも有料 API の実行許可ではなく、その後に en-generate-hub の MA-17 Human-only 承認（承認文の入力は Human）が必ずある。
2026-09-26 実JEV Calibration 以降の意味論（consumer が知っておくこと。閾値 0.85 / 0.60 は不変）：
- `human_review_required` は escalation-only（follow-up ② Hybrid）：true なら confidence に関わらず `tier:human`、false のときはその質問の確信度を全体 confidence に入れない
- Jev の回答が自己矛盾（schema の `x-outcome-invariants`。例：`paid_generation_required=false` かつ route `en-generate-hub`）していれば attempt の confidence は 0 になり human へ進む（usage は attempt に残る）
- 実測（synthetic 評価・holdout）は `docs/poc/calibration/2026-09-26-real-jev-calibration.md`。`tier:auto` はどの type でも承認ではない

## 12. Runtime environment（2026-09-26・Environment Isolation）

上位原則の正本は Vault「技術スタック選定・管理_正本」§3-8（E-NEXUS 共通基盤は**コードは共通、実行環境は分離**。DEV / STAGING / PRODUCTION）。
Decision Gateway への具体適用は Vault Decision Layer 正本 §18-7。ここには repo 側の実装事実だけを書く。

| 項目 | 実装 |
|---|---|
| 識別子 | `dev`（PERSONAL / DEV）／`staging`／`production`。`src/core/environment.mjs` |
| 決め方 | **Gateway を動かす runtime の env `EDL_ENVIRONMENT`**。未設定・空＝`dev`。それ以外の値（`prod` 等）は起動を拒否する（推測で補わない） |
| consumer の値 | request の `environment` は `via` と同じく **Gateway が上書き**（consumer の自由入力を信頼しない）。consumer は任意の `expected_environment` で想定環境を宣言でき、不一致は `ENVIRONMENT_MISMATCH`（409・engine を呼ばない・usage に書かない・fail-closed） |
| 可視化 | envelope `gateway.environment`・`gateway.version()`／`GET /health`・`/version`・`gateway health`・usage 行の `environment` |
| usage / logs | `dev` は従来の `data/usage/usage.jsonl`（既存履歴・`scripts/real-jev-evidence.mjs` と互換）。`staging` / `production` は `data/usage/<environment>/usage.jsonl` |
| mock | `verification`（mock-jev）は **dev 専用**。`staging` / `production` の runtime では Gateway が起動を拒否する |
| engine mode との違い | engine の `mode: production`＝「mock-jev を入れない判定モード」。**実行環境の PRODUCTION ではない**。実行環境は `environment` だけで表す |

**CLI / SDK の同居実行は DEV 扱い。** 子 process で CLI を起動する consumer は自分の env（`EDL_*` を含む）を Gateway に継がせるので、
CLI / SDK では「環境を決めているのは実質 consumer の process env」になる。したがって **`staging` / `production` を名乗れるのは、
deploy された HTTP Gateway の runtime 設定だけ**とする（consumer は HTTP の endpoint・service token を環境ごとに別に持つ）。
local CLI transport の consumer adapter は `dev` 以外を指定されたら接続せず fail-closed にする（en-sns-hub `src/growth-decision.mjs` が最初の実装例）。

**現在の実体（2026-09-26）**：実行環境は **dev だけ**。STAGING / PRODUCTION の Gateway・Backend は存在しない（未 deploy）。
Production を作るとき（Human-only）の要件：環境ごとに別の Secret（Jev key・`EDL_GATEWAY_TOKEN`）・endpoint・usage/log 置き場・rate limit・provider config、
PRODUCTION は pinned version（`master` / latest を無条件に追従しない）と安定版への rollback、DEV → STAGING → PRODUCTION の昇格、
一般販売 SaaS の client（iOS / Android / browser）は Gateway を直接呼ばず E-NEXUS Backend 経由（client に Secret を置かない）、
multi-tenant 識別は `application_id`・`tenant`（opaque ID）・`environment`、Production PII を Calibration / 開発試験に使わない。
