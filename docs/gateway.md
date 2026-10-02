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
                     Rules → Jev（Provider: direct＝TypeSafe Direct / cloudflare予約）→ local → llm → Human
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
| `input` | 必須 | decision_type 固有 schema で検証。**engine（Jev）へ送られる**。Secret・PII・prompt 全文・ローカルパスを入れない。`input.knowledge_context` は Decision Layer が Knowledge Layer から添える field で、**consumer は送れない**（`INVALID_ENVELOPE`・§13） |
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
| `DECISION_ABORTED`（呼び出し元が中断した：HTTP client の切断・shutdown。engine の故障ではない。2026-09-29） | aborted | true | 499 |
| `ENGINE_ERROR`（生 message は返さない） | engine_error | true | 502 |

**HTTP status は「Gateway が decision を返せたか」だけ**。`tier=human` でも 200（Decision 結果と status を混同しない）。

**timeout と中断（2026-09-29 FB-01 で解消。旧「timeout の既知の制約」）**：Gateway は decide ごとに `AbortController` を持ち、`GATEWAY_TIMEOUT` を返すと同時に engine を abort する
（engine 契約：`decide(request, { signal }?)`・第2引数は任意）。既定 engine は以後の Adapter を呼ばず（human への escalation も作らない）、
Direct Jev provider は in-flight の fetch と backoff 待機を止める（再試行しない・`JEV_ABORTED`）。途中までに呼んだ attempt があれば
**`aborted: true` の usage 行を1行**書く（`tier`・`resolved_by` は null＝判定に見せない。送信済みの Jev は `networked: true`・usage unknown として残り、
課金の証跡を失わない。attempt 0 件なら書かない）。同時実行枠は engine が実際に止まるまで保持する（実 Jev は abort で即座に止まる）。
signal を無視する engine は `abortGraceMs`（既定 5s・timer は unref）で枠を打ち切り、`stats.abandoned` に数える。HTTP 入口は
応答前に client が切断したら（`res` の `close`）同じ経路で abort する＝`DECISION_ABORTED`。`gateway.decide(raw, { via, signal })` の
`signal` は shutdown 等の呼び出し元の中断にも使える。別 process の consumer（en-generate-hub）が Gateway の 30s より長い 35s で子 process を
止める設計はそのまま（Gateway 側の構造化 envelope を先に受け取る）。

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
| `production`（既定） | rules → jev → local → llm → human | consumer 向け。**mock-jev は入らない**。Jev が使えない環境（キー無し／`EDL_ALLOW_NETWORK`≠true）では rules で解けなければ human。**llm（2026-09-29 FB-21・Claude）**は `options.allow_paid_adapters: true` の request だけ・HTTP runtime の鍵（`ENEXUS_LLM_ANTHROPIC_API_KEY`＝`credential:`）があるときだけ・tier は review が上限（`max_tier_by_adapter`） |
| `verification`（`--verification` / `EDL_GATEWAY_MODE=verification`） | 実 Jev が使えないときだけ mock-jev を追加 | 配管検証専用。結果の `provider:"mock"` を Jev の判断として扱わない |

既存 `createDecisionLayer()` / `cli decide` の既定（mock を入れる）は後方互換のため変えていない。consumer は Gateway を使う。

**Cost Gate 運用（§17-4 の決着）**：Gateway は利用可能なら実 Jev を既定で使う（キーと `EDL_ALLOW_NETWORK=true` がその process の env にある時）。
それが無い環境では rules → human で止まり、課金は発生しない。`EDL_ALLOW_NETWORK` を AI が勝手に true にしない（既存 CLAUDE.md）。
上限は同時実行 4・timeout 30s（**2026-09-29 見直し＝据え置き**）。当初の根拠（Vercel 経路で 1 判定 ≈52 USD micros・burst 5 連続で 429）は経路廃止で失効した。Direct の実測（S5・逐次 243 回）は latency 中央値 172〜202 ms・最大 383 ms・429 は 0 件、1 判定の入力は約 1,500〜2,700 token（smoke 64 µUSD・S5 平均約 114 µUSD・公表単価 $42/Btok 基準）。timeout 30s は Direct の再送（1 試行 10s・backoff 0.5s→1s）より長く、全試行 timeout の最悪（約 31.5s）は `GATEWAY_TIMEOUT`（fail-closed）へ倒れるので据え置く。同時 4 は Direct の burst を未実測（S5 は逐次）で、consumer 側の最大並列は Launcher の 2。4 で足りない実例が無いため上げない（上げる時は burst の実測＝実課金を伴うので Human の go を取る）。

## 5. 入口面（提供面）

| 面 | 起動 | 向く consumer | 状態 |
|---|---|---|---|
| SDK | `import { createGateway } from 'e-nexus-decision-layer'` → `gateway.decide(req, { via:'sdk' })` | 同一マシンの Node（E-NEXUS Apps のサーバ側） | 実装済み |
| CLI | `node src/cli.mjs gateway decide --stdin`（`--json` / `--file` も可） | Claude Code（Skill）・shell・別 repo の Node（en-generate-hub は子 process で使用） | 実装済み・**en-generate-hub が第1実consumer** |
| HTTP | `node src/cli.mjs gateway serve [--host] [--port 8787]`（常駐は `scripts/run-gateway.mjs --env-file`） | Python・Hermes・Worker・他 LLM Agent・VPS | 実装済み。**2026-09-29 Production-capable**（環境別の起動条件・pinned release・rate limit・access log・`/ready`・graceful shutdown・service 定義生成・smoke・HTTP transport）。常駐・deploy・token は Human-only（`docs/deploy-production-gateway.md`） |
| MCP | `node src/cli.mjs gateway mcp`（stdio） | Claude Code・Cursor・MCP 対応 Agent | 実装済み。**接続（MCP 設定への登録）は Human-only**（Vault MCP接続台帳 §4-7・§5・§8-2） |

HTTP endpoints：`POST /v1/decisions`（要認証）／`GET /v1/decision-types`（要認証）／`GET /v1/health`（要認証・詳細）／`GET /health`・`GET /version`（認証不要・最小情報。`/version` は pinned release も返す）／`GET /ready`（認証不要・draining 中 503）。`/v1/*` には rate limit（超過 429＋Retry-After・`{error:'RATE_LIMITED'}`）。

MCP tools：`enexus_decide`・`enexus_decision_types`・`enexus_gateway_health`（Jev 名を tool 名に入れない）。legacy era（initialize）で
`2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05` を交渉。modern era の `server/discover` には -32601 を返す（仕様上 legacy と判定され fallback される）。

## 6. 認証・境界（HTTP）

- 既定 bind は `127.0.0.1`。loopback 以外は `EDL_GATEWAY_TOKEN` 無しでは**起動しない**（fail-closed）
- token 設定時は `Authorization: Bearer` を sha256 digest の `timingSafeEqual` で照合。token 値は応答・ログに出さない
- `Origin` ヘッダ付き request は 403、POST の Content-Type が JSON 以外は 415（ブラウザの任意ページから localhost の有料 Jev 呼び出しを起こさせない）。body 上限 64KiB
- **staging / production は token 32 文字以上・`release.json`・`EDL_EXPECTED_RELEASE` 一致が無いと起動しない**（2026-09-29・`src/gateway/serve-config.mjs`）
- access log は body・token・IP・outcome を書かない（method・既知 path・status・latency・request_id・error code・environment だけ）
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
- 異常 digest（2026-09-29 FB-18）：`node scripts/usage-digest.mjs [--hours 24] [--environment <env>] [--access-log <stderr を保存した JSONL>] [--fail-on-anomaly]` が usage.jsonl（と任意で access log）を窓で要約する：consumer ごとの件数・tier・Human 率・Jev の成否と unavailable の理由・中断（aborted）と理由・既知の費用、HTTP の status と error code（ENVIRONMENT_MISMATCH・GATEWAY_BUSY 等 usage に残らない失敗）。基準（Human 率 0.9 以上かつ 5 件以上・Jev 失敗 5 割以上かつ 3 回以上・中断 1 件以上・5xx・401/403 が 5 回以上・429）を超えたものを `anomalies` に出す。input・outcome・correlation_id・request_id は持ち出さない。MA-30 §17-6 の「Jev low-confidence 通知」はこの digest が窓単位で兼ねる（`high_human_rate`・`jev_unavailable`。1判定ごとの通知は作らない：低確信度の判定は tier=human として各 consumer の画面で Human に届いている）。通知は任意・既定 OFF：`--webhook credential:E-NEXUS/edl/<name>`（URL は OS 資格情報ストアからだけ・https 必須・既定は異常がある時だけ・`--webhook-format json|slack|discord`）。webhook 先の登録と定期実行の登録は Human。共通通知 package は作らない（consumer ごと）

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
   **今の DEV Gateway へつながない**（Production Gateway は**コードは Production-capable（§6-1・`docs/deploy-production-gateway.md`）だが、まだ deploy されていない**＝常駐先・Secret・deploy は Human Required）。不明なら Production へ推測接続しない
3. **Decision Point**：どの時点で呼ぶかを 1〜2 箇所に絞る（全操作に通さない）
4. **decision_type**：`gateway types` の既存 type を使う。無ければ architecture §7（schema + index + rules + tests）。consumer が未知の type を作らない
5. **structured context**：`input` は decision_type schema の構造情報だけ。参照用 ID は `context`（engine へ送られない）。`correlation_id` に PII の無い業務 ID
6. **PII / Secret boundary**：`input` に Secret・PII・人物名・prompt / 本文の全文・ローカルパスを入れない。疑いがあれば本文を送らない（rules で止める）
7. **Gateway 呼び出し**：入口面を選ぶ（Node 同居 = SDK、shell / 別 repo = CLI、別言語・別マシン = HTTP、MCP 対応 Agent = MCP）。CLI は §9-4 の transport 契約に従う
8. **typed result 検証**：`contract_version`・`ok`・`decision` の有無・`gateway.environment` を確認し、`decision.outcome` / `tier` / `human_gate` を読む
9. **Human-only 境界**：`ok:true`・`tier:auto` でも承認ではない。結果に承認・実行キーを作らない。有料実行・公開・送信・deploy は既存 Human-only ゲートを通る
10. **failure / mismatch**：`ok:false` は `failure.policy`（human-required / deny）に従う。環境不一致・欠落・Gateway 不在・timeout・不正応答は fail-closed。**自動続行しない**。
    自動 retry は既定でしない。例外は常駐して判定を「取り直せる」consumer（2026-09-26〜 OpenMontage Launcher）だけで、範囲を次に限る：
    Engine に届いていない失敗（`GATEWAY_BUSY`・起動失敗）は短い即時 retry（最大 2 回）、Engine が走り続けて usage・課金が発生しうる失敗
    （`GATEWAY_TIMEOUT`・`ENGINE_ERROR`・不正応答。§2 timeout と中断：timeout 時点で送信済みの Jev は課金され得る）は即時に呼び直さず pending にして遅延再試行（上限あり）、
    尽きたら human-review。再試行中も結果は human-review 扱いで、承認・実行へは進まない（Performance-First：Vault 技術スタック正本 §3-0-7）
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
HTTP transport（2026-09-29・FB-05）：`consumer-kit/node/http-transport.mjs`・`consumer-kit/python/enexus_http_transport.py`（Hermes 等）。POST `/v1/decisions`・Bearer・**https 必須（dev の loopback http だけ例外）**・`expected_environment` を transport の環境で上書きし envelope を照合・timeout 35s・自動再試行なし・401／403／入口の 429／非 JSON／非 v1 は fail-closed。deploy された staging / production Gateway へつなぐ consumer はこれを使う（Gateway の deploy と token は Human-only）。旧記述「HTTP / Production 用 transport は Production Gateway の構築と同時に作る」は 2026-09-29 Human 発注（Full Autonomous Build）で上書き（Vault MA-30 正本§18-17）。Kit に Decision Engine 固有の名前は入れない（`tests/consumer-kit.test.mjs` が検査）。

### 9-5. consumer 一覧

| consumer | 状態（2026-09-26） | 次に作るもの |
|---|---|---|
| en-generate-hub（`paid-generation-gate`） | **接続済み**（`decision-gate`・CLI transport）。2026-09-26 実 Jev 到達確認。同日 `expected_environment: dev` と environment 照合を追加（標準準拠） | transport を `consumer-kit/node/cli-transport.mjs` へ寄せるのは任意（次に触る時） |
| Claude Code | **接続済み**（Vault Skill `enexus-decision` + CLAUDE.md の発動ルール・CLI）。2026-09-26 実 Jev 到達確認。同日 Skill の request に `expected_environment: dev` を追加。MCP は任意（Skill＋CLI で自動発動しているため不要＝2026-09-29 Human Last-Mile Activation。使うなら接続は Human） | — |
| SNS / Growth（`channel-selection`・`content-publish-gate`） | **接続済み（2026-09-26・dev）**：en-sns-hub `src/growth-decision.mjs`（thin adapter・CLI transport・`expected_environment: dev`）＋ `POST /api/decide`。実 Jev 到達確認。**2026-09-29 FB-23**：スマホ版 Worker にも同じ判定（`worker/src/decision.mjs`・判定の組み立ては `src/growth-decision-core.mjs` を共用・transport は kit の HTTP transport の写し・既定 OFF） | Worker 版は HTTP Gateway が要る（deploy は Human-only）。transport の kit 移行は任意 |
| **OpenMontage（`paid-generation-gate`）** | **workflow 接続済み（2026-09-26・dev・proposal gate 境界）**：thin adapter `integrations/openmontage/enexus_openmontage_decision.py`（Python・CLI transport・`application_id: openmontage`）＋ preflight wrapper `enexus_openmontage_preflight.py`（OpenMontage の proposal checkpoint＝`awaiting_human` の production plan を JSON で読み、生成系 tool ごとに adapter を呼ぶ）。OpenMontage 上流の checkpoint writer が書いた checkpoint から実 Jev 到達確認。route=en-generate-hub は /en-generate（MA-17）への引き継ぎ候補で、OpenMontage 内蔵の有料 tool は使わない。**2026-09-26 自動化**：`enexus_openmontage_launcher.py`（Launcher）が OpenMontage を起動し、gate checkpoint（proposal／proposal の無い pipeline は scene_plan）を監視して preflight を自動実行する（Human / agent が wrapper を覚えて呼ぶ必要はない・上流無改変）。agent の env から有料 provider の鍵を外し、報告の場所を session 限りの追記指示で伝える 同日さらに **常駐化**：Windows ログオン時に watcher を Task Scheduler で自動起動（`autostart install`・1 分 watchdog・OS file lock で二重起動なし）。Launcher を通さず clone で直接起動しても常駐 watcher が判定し、注意が要る判定・OpenMontage 内の有料 tool 実行を Windows 通知で知らせる | direct 起動の有料鍵：2026-09-26 に en-generate-hub の Paid Provider Secret Boundary で鍵を User env から資格情報マネージャーへ移し、MA-17 承認済み実行だけが取得する構造にした（2026-09-26 に Human 移行とサインアウト後の最終確認まで完了＝有効・Vault MA-17 正本 §21）。consumer へ有料鍵を配らない。Mac mini の LaunchAgent は未検証 |
| Cursor | **rule 配置済み**（2026-09-29：`e-nexus-decision-layer`・`en-sns-hub`・`en-generate-hub` の `.cursor/rules/enexus-decision.mdc`・兄弟フォルダ前提の相対パス。雛形は `integrations/cursor/enexus-decision.mdc`＝Claude Code の Skill と同じ契約・`application_id: cursor`） | （任意）MCP 設定（Human） |
| Hermes | 未導入（設計のみ・MA-24） | 導入時に HTTP か MCP の adapter。**2026-09-29：Python の HTTP transport（`consumer-kit/python/enexus_http_transport.py`）を用意済み**＝Hermes 側はこれをコピーするだけ |
| OpenAI 系 Agent / 他 LLM | consumer 未存在 | MCP（Agents SDK）か HTTP の adapter |
| LINE / CRM | 2026-09-29：`lead-triage`・`customer-reply-gate`・`automation-safety-gate` を実働化し、crm-core に入力写像（`src/decision/decision-inputs.mjs`）。送信 executor の preflight（2026-09-29 FB-16・crm-core `src/execution/decision-preflight.mjs`・`application_id: crm-executor`）から HTTP で automation-safety-gate（dry-run・execute）と customer-reply-gate（caller が `reply_facts` を渡した dry-run だけ）を呼ぶ。止めることしかしない・既定 OFF（staging / production の Gateway と token が要る＝Human）。production の G5 は rule で human-review になり、execute では署名付き Human 承認で満たされたとみなす。lead-triage は executor Worker の `POST /v1/triage`（read-only・送らない・既定OFF・2026-09-29 FB-24）。受信口（canary）の経路には入れない。評価セット（synthetic・holdout・敵対）は `docs/poc/calibration/` に凍結済み（FB-15・offline で検証） | Gateway の deploy と token（Human）・実 JEV Calibration run の go（課金・Human） |
| 一般販売 App / SaaS（AI Cost Manager・旅レートカメラ・足場 SaaS 等） | 未接続 | **Production Backend → Production Gateway**（コードは用意済み・deploy は Human Required）。client に Secret を置かない。DEV Gateway へつながない（§12） |
| **AI Infrastructure Watcher（`infra-change-triage`・Vault MA-33）** | **接続済み（2026-10-02・dev・process 境界）**：Watcher（e-nexus-knowledge-layer `watcher/`）は Gateway を呼ばず request JSONL（事実だけ）を出し、本 repo の `scripts/watcher-triage.mjs` が `gateway.decide` に通して `{change_id, envelope}` を返す。`scripts/watcher-cycle.mjs --watcher-dir …` が 1 サイクル（scan→triage→Gateway→ingest→propose→handoff→observe）を組み立て、`scheduled-job-service.mjs --job watcher-cycle` が常駐定義を生成（登録は Human）。rules-reference・catch-all・Jev なし・課金なし。envelope は承認ではない（proposal_candidate／human_attention は tier human） | Jev 接続（価値判定）は Cost Gate 配下で後続。常駐の登録先（Mac mini／Windows／VPS）は実行基盤側の運用で、Watcher の完了条件ではない（2026-10-02 Human 決定） |

## 10. Engine の差し替え

- **Jev だけ替える**：Adapter / Provider の差し替え（architecture §7・§9）と `policies/gateway/engine-env.json`（engine が読む env 名）の更新。Gateway・consumer は無変更
- **Decision Layer ごと替える**：`src/gateway/engine.mjs` の契約（`id` / `version` / `mode` / `decide()` / `health()`）を満たす engine を `createGateway({ engine })` に渡す。
  consumer が見る envelope の形は同一で、変わるのは `gateway.engine` だけ（`tests/gateway.test.mjs` の engine swap テスト）

## 11. 実 Jev 経路の有効化と証跡（2026-09-26・MA-30 実JEV第1段）

### 11-1. 有効化条件（現行コードが正）

| env | 値 | 読む場所 |
|---|---|---|
| `EDL_ALLOW_NETWORK` | `true` | jev-adapter / 各 Provider（二重チェック）。これが無いと送信前に `NETWORK_DISABLED` |
| `JEV_PROVIDER` | `direct`（未設定でも `direct`） | provider 選択。**`vercel` は 2026-09-29 に廃止**＝`vercel` のままだと `JEV_PROVIDER_UNKNOWN` で Jev は使われず human へ倒れる |
| `JEV_API_KEY` | （Secret。Human のみが設定。発行は console.typesafe.ai/keys） | direct provider。無いと `JEV_API_KEY_MISSING`。公式 SDK の名前 `TYPESAFE_API_KEY` は読まない |
| 任意：`JEV_MODEL`（既定 `jev-latest`）・`JEV_API_BASE_URL`・`JEV_TIMEOUT_MS`（既定 10000） | | direct provider |

- 3 つが **Gateway を起動する process の env** に揃ったときだけ実 Jev へ送る。CLI は `.env` を読まない。AI は設定しない（CLAUDE.md）
- `gateway health` の `engine_health.jev` = `{ provider, network_enabled, usable, reason }`（キーの有無のみ）。`usable:true` が前提条件
- Gateway timeout 30s・同時実行 4（§4）。Direct provider は 1 試行 10s、408/429/5xx/529/timeout を最大 2 回 retry（backoff 0.5s→1s・`Retry-After` 尊重）。401/402/403/400/422 は再試行しない。失敗は reason 語彙（`JEV_AUTH_FAILED` / `JEV_FORBIDDEN` / `JEV_PAYMENT_REQUIRED` / `JEV_REQUEST_REJECTED` / `JEV_RATE_LIMITED` / `JEV_OVERLOADED` / `JEV_TIMEOUT` / `JEV_MALFORMED_RESPONSE` 等）で attempts[] に残り、human へ倒れる（`tests/gateway-real-jev-path.test.mjs`）

### 11-2. consumer へ渡す env は engine-env manifest が決める

別 process で Gateway CLI を起動する consumer（en-generate-hub 等）は、子 process に **OS 基本 + `EDL_*` + `policies/gateway/engine-env.json` の名前** だけを渡す。
consumer は Jev 固有の env 名（`JEV_*` 等）をコードに持たない。2026-09-29 の Vercel 廃止では manifest から `AI_GATEWAY_*`・`JEV_VERCEL_MODEL`・`JEV_ZDR` を外しただけで、consumer のコードは変えていない。engine を替えるときはこの manifest だけ変える。
manifest が読めない consumer は `EDL_*` だけを渡す（外部判断経路が使えず human へ倒れる＝fail-closed）。
`tests/gateway-engine-env.test.mjs` が「src が読む env 名をすべて manifest が網羅している」ことを検査する。Claude Code（Skill → CLI）は Claude Code process の env をそのまま継承する。

### 11-3. 「実 Jev を使った」の判定

`resolved_by` では判定しない（実 Jev が正常応答しても confidence が閾値未満なら `tier:human`・`resolved_by:human` になる）。
usage.jsonl の行の `attempts[]` に **`adapter=jev`・`status=ok`・`networked=true`・`route` が実経路（`direct`。2026-09-29 以前の行は廃止済みの `vercel`）・`input_tokens>0`** があれば実 Jev 証跡。

```bash
node scripts/real-jev-evidence.mjs --since <smoke開始のISO時刻> --expect claude-code,en-generate-hub   # 両 consumer に証跡が無ければ exit 1
```

2026-09-29〜：Jev の ok attempt は任意フィールド `model_version`（応答から分かる実版。alias しか無ければ `null`）と `evidence`（`response_model`・`model_version_source`・Gateway `routing.resolved_provider`・question ごとの `probabilities`）を持つ。**観測用で tier・confidence には使わない**。Contract v1 の envelope 項目は変えていない（`decision.fallback.trace` の attempt record へ任意項目を足しただけ・後方互換）。Direct の応答 `model` は実際に答えた版（例 `jev-1.13.0`）なので `model_version` に入る（`jev-latest` 等の alias なら `null`）。Gateway `routing` は廃止した Vercel 経路でだけ付いた項目。

### 11-4. smoke 手順（Human が env を設定した後。有料生成・公開・production mutation はしない）

1. `node src/cli.mjs gateway health` → `jev.usable: true`・`provider: direct`
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

**現在の実体（2026-09-26）**：実行環境は **dev だけ**。STAGING / PRODUCTION の Gateway・Backend は存在しない（未 deploy）。→ **2026-09-29**：STAGING / PRODUCTION で動かすための実装（起動条件・pinned release・運用機能・service 定義・smoke・HTTP transport）は完成。deploy・token・Secret・常駐登録は Human-only のまま（`docs/deploy-production-gateway.md`）。
Production を作るとき（Human-only）の要件：環境ごとに別の Secret（Jev key・`EDL_GATEWAY_TOKEN`）・endpoint・usage/log 置き場・rate limit・provider config、
PRODUCTION は pinned version（`master` / latest を無条件に追従しない）と安定版への rollback、DEV → STAGING → PRODUCTION の昇格、
一般販売 SaaS の client（iOS / Android / browser）は Gateway を直接呼ばず E-NEXUS Backend 経由（client に Secret を置かない）、
multi-tenant 識別は `application_id`・`tenant`（opaque ID）・`environment`、Production PII を Calibration / 開発試験に使わない。

## 13. Knowledge Context（2026-10-02・Vault MA-32-4）

上位正本は Vault の MA-32 構想正本 §9（Knowledge / Relationship Layer との接続）。ここには repo 側の実装事実だけを書く。

- **責務**：Knowledge は「何が分かっているか」（事実・経路・鮮度・出所）、判断は Rules／Jev。Decision Layer は Knowledge から判断を作らず、事実を input に添えるだけ
- **経路**：consumer は従来どおりの request を送る（Entity ID・query・保存形式を知らない）→ engine（`createDecisionLayerEngine`）が、`policies/knowledge/context-requirements.json` に載った decision_type だけ Knowledge Context を `input.knowledge_context` に置く → core（schema → safety → rules → Jev …）。**core（`src/core/`）は Knowledge を知らない**
- **provider は注入**：`createDecisionLayerEngine({ knowledge: { provider, timeoutMs? } })`。provider port は `{ id, version, getContext(request, {signal}) }`。注入しなければ従来と同一（`decision.knowledge` も付かない）
- **CLI への配線（2026-10-02・Vault MA-32-5）**：`gateway decide`／`gateway health` は、runtime 環境が dev のときだけ、Knowledge Context contract を stdin／stdout の JSON で話す子 process（`src/knowledge/process-provider.mjs`）を provider として注入する。起動するコマンドの場所は `policies/knowledge/provider.json`（`EDL_KNOWLEDGE=off`＝使わない／`EDL_KNOWLEDGE_HOME`＝そこ。使えなければ毎回 `unavailable(source_unavailable)`＝黙って Knowledge 無しへ戻さない／どちらも無ければ兄弟フォルダ。無ければ未設定＝従来と同一）。子 process の env は OS の最低限だけ（Jev の鍵等を Knowledge 側へ継がせない）。exit code は見ず stdout の context を読み、検査は enricher が行う。`gateway health` の `knowledge_runtime` に status（configured／not_found／misconfigured／disabled）と source を出す（path は出さない）。**HTTP Gateway（`serve`・`run-gateway`・`serve-config`・`deploy/`）と MCP は注入しない（LATER）**＝VPS staging は従来と同一（`tests/knowledge-process-provider.test.mjs` が構造で固定）
- **usage の要約**：Knowledge を注入した engine は usage 行に `knowledge`（requested・status・reason・rule_id・provider・environment・warnings・latency_ms）を足す（meter を engine が包む。core は無変更・envelope の `decision.usage` は従来の形）。`not_requested` も残るので Rules First の効き具合が usage から分かる
- **Rules First**：knowledge_context を見ない rule を input だけで先に評価し、一致すれば Knowledge を問い合わせない（`decision.knowledge.status = not_requested`・`reason = rules_decided`・`rule_id`）。Knowledge を見る rule は rules ファイルの末尾に置く（loader が検査）
- **失敗の意味を丸めない**：context の `status`（`ok`／`partial`／`subject_not_found`／`unavailable`）・`reason`（`source_unavailable`・`data_integrity_error`・`timeout`・`provider_error`・`malformed_response` 等）・state の `unknown`／`stale`・環境ごとの `coverage` をそのまま input に載せる。`automation-safety-gate` は production で `subject_not_found`／`unavailable`／impact の失敗なら rules（`knowledge-*`）が human-review へ上げる。dev／staging は止めずに Jev へ事実ごと渡す
- **受け取る側の検査**：`schemas/common/knowledge-context.schema.json`＋id の形・判断 key・Secret／PII 風の値・16KB 上限・authority 番号。通らなければ `unavailable(malformed_response)`（部分的に使わない）。provider の例外・timeout（既定 2s）も `unavailable`
- **explainability**：`decision.knowledge`（任意）＝ contract・requirement・provider・requested・status・reason・as_of・environment・subject・warnings・`refs`（entity id・relation key・state key だけ）・latency_ms。判断の根拠になった rule は `rationale` の `rule:<id>`。Knowledge の中身は返さない
- **Contract**：Gateway Contract version は `1` のまま（envelope の key は不変。`decision.knowledge` は任意 field）。Jev の段で knowledge_context を使った判定は未較正（`x-jev-brief` は不変）
- **確認**：`tests/knowledge-integration.test.mjs`（fake provider）・`tests/knowledge-process-provider.test.mjs`（子 process・CLI 配線）・`node scripts/knowledge-integration-e2e.mjs --knowledge-layer <dir> --map <project-integration-map.json>`（SDK・実データ・dev 専用・課金なし）・`node scripts/agent-integration-e2e.mjs --knowledge-layer <dir> --map <…>`（**実 CLI を Claude Code と同じ形で子 process 起動**・failure injection・課金なし）
- **実測の隔離（2026-10-02）**：Knowledge Layer は data/state の壊れた・契約外の実測だけを除外して開き、context の warnings に `state_records_quarantined` を付ける（schema の enum に追加）。data/knowledge 側の問題は従来どおり `unavailable(data_integrity_error)`


## 14. Agent Integration Contract（2026-10-02・Vault MA-32-5）

上位正本は Vault の MA-32 構想正本 §10（Agent／Executor 接続）。どの Agent（Claude Code・Hermes・Cursor・Codex・OpenAI 系）でも同じ形でつなぐ。Agent 専用の Knowledge 実装・Decision 実装は作らない。

```
Agent ─ consumer adapter（Skill／rule／HTTP transport：request を組み envelope を読む薄い層）
      ─ Gateway（Contract v1：envelope 検証・環境・大きさ・Secret・knowledge_context 偽造の拒否）
      ─ engine の組み立て（CLI composition root：Knowledge provider を注入）─ Knowledge Context provider（子 process・事実だけ）
      ─ Decision Layer core（schema → safety → rules → Jev → … → Human）
      ─ envelope ─ consumer adapter（interpretEnvelope：次の行動へ写す。緩めない）─ Agent
```

| Agent が送ってよい | Agent が送れない／名乗れない |
|---|---|
| `application_id`（自分の識別子）・`project_id`（対象）・`decision_type`・`input`（その type の schema の構造情報＝作業の種類・対象環境・副作用の区分・費用の区分）・`context`（参照用 ID）・`expected_environment`・`correlation_id` | `input.knowledge_context`（Knowledge は Decision Layer が取る＝`INVALID_ENVELOPE`）・承認済み／Human 確認済みの主張（schema に field が無い＝`SCHEMA_INVALID`）・出所や鮮度（authority・provenance・current）・`environment`／`via`（Gateway が上書き）・鍵・token の形の値（input／context のどこでも `INVALID_ENVELOPE`）・64KiB を超える request |

- **Agent が知らなくてよいもの**：Knowledge の保存形式・置き場・Entity ID の規則・engine・Decision Engine（Jev 等）の名前と env・provider。Agent が持つのは request／response の契約だけ
- **identity は権限ではない**：`application_id` は usage の集計と表示のためで、同じ input なら誰が名乗っても同じ判定（`tests/executor-route.test.mjs`）。consumer の中央 registry は作らない（§9-1）。作業を実際に行う Executor の静的能力は `registries/agents.json` の `type: executor`
- **外部の文字列はデータ**：tool result・Web 本文等を input に入れても system instruction にならない。判断に使うのは schema の構造 field で、`summary` 等の自由文で rules の判定は変わらない（同 test）。鍵の形の値は Gateway で止まる
- **結果の扱い**（`consumer-kit/conformance/interpretation-cases.json`・Node `consumer-kit/node/interpret.mjs`・Python `consumer-kit/python/enexus_interpret.py`）：`candidate`（tier auto＝次の段階の候補。許可ではない）／`review`（Advisor 相談か Human 確認）／`human`（Human へ返す）／`stop`（failure policy deny）。approval は常に false。tier auto でも `human_gate.required`・decision の欠落・環境の不一致・不明な tier・承認風の outcome key・壊れた envelope は `human`。**Knowledge の unavailable／partial／stale／unknown を Agent が補完・格上げしない**（decision をそのまま読む。「とりあえず実行」はしない）
- **executor-route**（rules-reference）：作業1件をどの Executor に振るかの参考値。Human-only 境界は `human`、Vault 書き込みは `claude-code`、planned の Hermes は推奨しない、稼働状態は未実測（`availability_checked: false`。producer は MA-33 Watcher・Runtime Node）。rules が catch-all まで答える＝Jev へ流さない。**2026-10-02**：外部側（ベンダー公式 status）は Watcher が `agent:claude-code`・`agent:cursor` の `health.external.status` として Knowledge に入れ始めた。ただしこれは「ベンダー側の障害の有無」で、「このノードで executor を実行できるか」（runtime availability）ではないので、`availability_checked` は false のまま。判断側で使うには、executor を subject にした Knowledge Context と、input だけの catch-all より前に置く rule の設計が要る（Rules First の配置・Knowledge Context の subject が project だけ、の 2 点が論点）。別の設計 step として残す。`infra-change-triage` には `subject_type: agent`（使っている executor のベンダー障害 major／critical は impact 無しでも human_attention）を追加済み
- **接続状態**（2026-10-02）：Claude Code＝CONNECTED_LOCAL（Skill → CLI → Knowledge 注入・dev）／Hermes＝CONTRACT_READY（HTTP transport と interpret の Python 版・未導入。HTTP Gateway への Knowledge 配線は LATER のため、HTTP 経由では Knowledge 無しの従来判定）／Cursor＝rule 配置済み（CLI。Skill と同じ契約）／HTTP Gateway（VPS staging）・MCP＝LATER
