# HTTP Gateway の staging / production 運用（deploy・昇格・rollback）

2026-09-29 作成（Full Autonomous Build FB-05・AI）。**ここに書く操作はすべて Human-only**（deploy・常駐登録・token 発行・Secret 投入・
`EDL_ENVIRONMENT` を staging / production にすること・Gateway 切替・DNS／前段認証。技術スタック正本§3-8-7）。
AI が用意したのは、その操作を安全に行うための実装・生成物・検証（下の「用意済み」）で、実行はしていない。
上位原則：コードは共通、実行環境は分離（Vault 技術スタック正本§3-8・本 repo docs/gateway.md §12）。

## 1. 用意済み（AI・2026-09-29）

| 部品 | 中身 |
|---|---|
| `gateway serve` の起動条件 | `src/gateway/serve-config.mjs`：staging / production は **token 32 文字以上・`release.json`・`EDL_EXPECTED_RELEASE` 一致**が無いと起動しない（pinned version。意図しない版で動かない）。loopback 以外は全環境で token 必須。mock-jev は dev 専用（従来） |
| 運用機能 | rate limit（`EDL_GATEWAY_RATE_LIMIT_PER_MIN`・staging/production 既定 600/分・`/v1/*`・429＋Retry-After）／access log（stderr・1 request 1 行 JSON・body／token／IP／outcome なし）／`GET /ready`（draining 中 503）／graceful shutdown（SIGTERM → 受付停止 → 進行中 decision を SHUTDOWN で abort〈送信済み Jev は usage に残る〉→ `EDL_GATEWAY_DRAIN_MS` 後に接続を閉じる） |
| 起動 wrapper | `scripts/run-gateway.mjs --env-file <path>`：env file を読み、`credential:E-NEXUS/edl/<name>` の値を OS 資格情報ストア（Windows 資格情報マネージャー／macOS Keychain）から解決（Secret を平文ファイル・User 環境変数に置かない） |
| service 定義 | `scripts/gateway-service.mjs --target systemd|launchd|windows`：定義を生成するだけ（登録はしない）。Secret を含まない。launchd は `--node <node の絶対パス>` か `--path` が必須（2026-09-29：Homebrew の PATH を固定で書くのをやめた。実機で `command -v node`） |
| pinned release | `scripts/gateway-release.mjs stamp|show|previous`：deploy 先の checkout の HEAD を `release.json` へ固定し、`releases.jsonl` から rollback 先を出す |
| smoke | `scripts/gateway-smoke.mjs`：/health・/ready・/version（release）・401・403・認証付き health・rules だけで決まる判定（Jev を呼ばない） |
| consumer 側 | `consumer-kit/node/http-transport.mjs`・`consumer-kit/python/enexus_http_transport.py`（Hermes 等）：https 必須・環境照合・fail-closed |
| tests | `tests/gateway-production.test.mjs`（起動条件・rate limit・access log・shutdown・transport 2 言語・service 定義・env file・release・smoke） |

## 2. 環境ごとの設定（env file の例・値は Human が入れる）

```
# /etc/e-nexus/gateway-staging.env（root だけが読める。Windows は本人だけが読めるフォルダ）
EDL_ENVIRONMENT=staging
EDL_EXPECTED_RELEASE=<pinned commit>
EDL_GATEWAY_TOKEN=credential:E-NEXUS/edl/gateway-token-staging
EDL_ALLOW_NETWORK=true
JEV_API_KEY=credential:E-NEXUS/edl/jev-key-staging
EDL_GATEWAY_RATE_LIMIT_PER_MIN=600
```

- **環境ごとに別の値**：token・Jev key（staging と production で分ける）・endpoint・usage の置き場（`data/usage/<environment>/usage.jsonl`・自動で分かれる）
- Linux（VPS）には OS 資格情報ストアが無いので、`credential:` は使えない：env file を root 所有・`chmod 600` にして値を直接書く（systemd の `EnvironmentFile` と同じ扱い）
- `EDL_ALLOW_NETWORK=true` を入れない場合、Jev は呼ばれず rules → human に倒れる（fail-closed・課金なし）
- **LLM 再判定（任意・2026-09-29 FB-21）**：`ENEXUS_LLM_ANTHROPIC_API_KEY=credential:E-NEXUS/edl/llm-anthropic`（Anthropic の API key・環境ごとに別）を足し、Gateway の host で `npm install`（`@anthropic-ai/sdk` は optionalDependencies・版は package.json で固定）。**これだけでは呼ばれない**：consumer が request の `options.allow_paid_adapters: true` を付けた判定だけで、tier の上限は review（auto にならない）。`EDL_ALLOW_NETWORK=true` も要る。名前に `EDL_` を付けないので CLI consumer の子 process へは渡らない（`policies/gateway/engine-env.json` の `runtime_only`）。モデル・単価・effort は `policies/llm/anthropic.json`（既定 `claude-opus-5-5`・effort low）。**server-side fallback（`fallbacks`）は使わない**（2026-09-29 独立監査：安全分類器の拒否を別モデルで答え直させる機能で、過負荷・429・5xx では発動しない。拒否は Human へ上げる。policy に null 以外を書くと adapter が `LLM_REFUSAL_FALLBACK_FORBIDDEN` で呼ばない・decision-log 2026-09-29）

## 3. 昇格の順（DEV → STAGING → PRODUCTION・Human-only）

1. DEV：`npm test` と OpenMontage の Python tests が通る commit を選ぶ
2. STAGING の checkout で `git fetch` → その commit を checkout（detached）→ `node scripts/gateway-release.mjs stamp` → env file の `EDL_EXPECTED_RELEASE` をその commit に
3. service 定義を生成して登録（例：`node scripts/gateway-service.mjs --target systemd --environment staging --dir /opt/e-nexus-decision-layer --env-file /etc/e-nexus/gateway-staging.env`）→ 起動
4. `EDL_GATEWAY_TOKEN=… node scripts/gateway-smoke.mjs --url https://<staging> --environment staging --release <commit>` が `SMOKE PASS`
5. consumer（Hermes・Worker・Backend）を staging の endpoint・token でつなぎ、`gateway.environment` が staging であることを確かめる
6. PRODUCTION：2〜4 を production の checkout・env file・token で繰り返す（**staging で確かめた同じ commit だけ**）

外部公開する場合（VPS 等）は、前段に TLS 終端と前段認証（Cloudflare Access 等）を置き、Gateway 自体は `127.0.0.1` に bind する構成を推奨（token は二重の防御）。

## 4. rollback（Human-only）

1. `node scripts/gateway-release.mjs previous` → `rollback_to.commit`
2. その commit を checkout → `stamp` → env file の `EDL_EXPECTED_RELEASE` を更新 → service を再起動（graceful shutdown が効く）
3. smoke を `--release <戻した commit>` で確認

戻しても usage の行・判定の記録は残る（削除しない）。schema・rules の変更を含む版を戻すときは、consumer が新しい decision_type を呼んでいないか確認する（呼べば `UNKNOWN_DECISION_TYPE`＝fail-closed）。

## 5. 監視

- 生存：`GET /health`・`GET /ready`（認証なし・最小情報）
- 詳細：`GET /v1/health`（要認証）＝ stats（requests・failed・errors_by_code・aborted・abandoned・latency）・rate limit・release
- ログ：stderr の JSON 行（`event: listening|refused_to_start|draining|stopped` と access log）。service manager のログ（journalctl／launchd の `StandardErrorPath`／Task Scheduler）で見る
- usage：`node src/cli.mjs usage --by application_id`（`EDL_ENVIRONMENT` を合わせて実行すると、その環境の usage を読む）
- 異常 digest（2026-09-29）：`node scripts/usage-digest.mjs --environment <staging|production> --hours 24 --access-log <保存した stderr> --fail-on-anomaly [--webhook credential:E-NEXUS/edl/digest-webhook --webhook-format slack]`。定期実行（systemd timer・launchd `StartCalendarInterval`・Task Scheduler の日次）と webhook URL の資格情報ストアへの保存は Human。launchd／Task Scheduler の定義は `node scripts/scheduled-job-service.mjs --job usage-digest --target launchd|windows ...` で生成できる（生成だけ・2026-09-29）。Mac mini への配置は `deploy/macos/MIGRATION.md`。exit 1＝異常あり（scheduler 側で失敗として見える）

## 6. やらないこと（設計判断・変えない）

- multi-tenant の切り分け・BYOK（採用設計が無い。`application_id`・`tenant` を request に持てる構造は既にある）
- Worker から core を直接 import（2026-09-25 却下。Worker は HTTP Gateway を呼ぶ）
- cloudflare Jev provider（API 仕様未確認・推測実装しない）
