# PoC: 有料生成API直前の Decision Gate（`paid-generation-gate`）

## 選定理由（2026-09-19）

候補は3つあった：①有料生成直前のDecision Gate ②Model Router ③Skill Router。①を採用。

| 観点 | ① 有料生成Gate | ② Model Router | ③ Skill Router |
|---|---|---|---|
| リスク | 低。en-generate-hub の**手前**で動き、承認・予算・台帳に触れない | 中。Claude Code の Model 選定は settings.json（Human-only）と結び付き、実接続には権限変更が要る | 中。Claude Code の Skill 起動は本体の暗黙判断で、差し込み口が無い |
| 効果測定 | 容易。「有料が要らなかった件数」「Human review に上がった件数」を usage.jsonl で数えられる | 難。既存の rules 表（Advisor§2-2）が既に決定的で、Jev の出番が少ない | 難。正解ラベルが無い |
| 既存構造との一致 | MA-29 OpenMontage ログ §12–13 が「支払い前ゲート」を接続候補として既に記録 | AI-Company §6 の表が既に rules。Jev 不要 | Skill台帳が人間向けで機械可読でない |

②は **rules だけで完結する**ことが監査で分かったため、Jev PoC には向かない（代わりに `policies/routing/rules/model-route.json` として rules 化し、Sonnet First / Advisor 13条件 / Fable 特別承認制を機械可読にした）。

## 入出力

```
input : asset_kind, purpose, style?, duration_sec?, has_reference_media?, has_local_assets?, estimated_paid_cost_usd_micros?, language?
outcome: local_sufficient, remotion_suitable, paid_generation_required, human_review_required, recommended_route(local|remotion|en-generate-hub|human-review)
```

`paid_generation_required=true` は「en-generate-hub の Human-only 承認フローへ持ち込む価値がある」という意味でしかなく、**実行許可ではない**。

## 判定順

1. rules：字幕・kinetic typography・slideshow → Remotion（MA-29 で Human 確認済み）／素材あり＋flat → local／推定 $5 以上 → 必ず human
2. mock-jev：photoreal / cinematic / 参照素材あり → 有料候補 + human review（confidence 0.75–0.88）／曖昧 → 0.55 → human
3. human：escalation

## 測定するもの（usage.jsonl）

- `resolved_by` の分布（rules で何割解けたか＝Jev を呼ばずに済んだ割合）
- `tier` の分布（auto / review / human）
- `fallback_occurred`・`human_escalation` の比率
- `attempts[]`／`usage_total`：Jev を実際に呼んだ件数（`networked`）・その cost・confidence 分布（final が human でも残る。architecture §11）
- 閾値調整はこの実測を根拠に行う

## 実接続確認（Vercel経路、2026-09-19）

`request-vercel-test.json`（repo直下）が実疎通用の入力例。photoreal シーン + `paid-generation-gate`。

```
node src/cli.mjs decide --file request-vercel-test.json
```

`JEV_PROVIDER=vercel`・`AI_GATEWAY_API_KEY`・`EDL_ALLOW_NETWORK=true` をシェルへ export した状態で実行し、Human が成功を確認した（`.env` はCLI から読まれないため、実行前にシェルへ export する。§`.env.example`）。結果：`rules:unavailable(NO_RULE_MATCHED) → jev:ok(confidence≈0.08, tier=human, latency 881ms) → local:unavailable(LOCAL_MODEL_NOT_CONFIGURED) → human:ok`。`resolved_by: human`。`mock-jev` は `NOT_REGISTERED`（`src/index.mjs` の `realJevUsable()` により実 Jev 経路使用時は chain に登録されないことを実測確認。詳細は `docs/decision-log.md`）。

## 接続（未実装・Human 判断待ち）

OpenMontage の `video_generation` カテゴリ（27ツール）が「支払い前にツール名・Provider・モデル・理由を宣言してターンを終える」設計なので、
その宣言を `decide` へ渡し、`recommended_route=en-generate-hub` のときだけ `/en-generate` Skill（見積・承認提示）へ進む、が自然な接続点。
OpenMontage 本体・en-generate-hub 本体は変更しない（wrapper / integration 側で接続）。

## Confidence Calibration（2026-09-19、OpenMontage 接続層の前）

目的：Jev の confidence 分布・question ごとの confidence・cost・latency を代表ケースで実測し、現在の question 設計と閾値（auto_min 0.85 / review_min 0.60）が妥当かを判断する。単一ケース（初回実疎通の confidence≈0.08）だけを根拠に閾値を変えない。

### 監査で確定した事実（コードから。API 呼び出しなし）

| # | 事実 | 影響 |
|---|---|---|
| 1 | 初回実疎通時の outcome schema には `description` が無く、Jev への instructions は 5 問すべて `Determine <field> for this paid-generation-gate decision.`（判断基準ゼロ）だった | Jev は `local` / `remotion` / `en-generate-hub` の意味を知らされていない |
| 2 | `recommended_route` の choice criteria は `{local: null, …}` → Vercel 経路では空文字 `''` | 4 選択肢の説明ゼロ |
| 3 | 全体 confidence = 5 問の **min**。boolean 4 問は `\|2p−1\|` 導出 | 1 問でも p≈0.5 なら全体が潰れる。0.08 = ある 1 問が p≈0.54 |
| 4 | auto_min 0.85 に届くには boolean 4 問すべて p≥0.925（または ≤0.075）かつ choice ≥0.85 が同時に必要 | 閾値と合成方式の組み合わせとして auto は構造的に到達困難 |
| 5 | rule `local-assets-present-and-flat` は `has_local_assets=true` + flat/motion-graphics だけで確定し `purpose` を見ない（ケース D1） | 「無い素材が要る」旨が purpose にあっても rules が local で確定する。Rules を弱めない（記録のみ） |

解釈：0.08 の主因候補は **question 設計不足（#1・#2）× min 合成（#3）** であり、閾値の問題として扱う根拠は無い。ただし実測で確認するまで確定しない（下記 Human Required）。

### 実施した最小修正（question 設計。閾値・Human Gate・chain・policy は不変）

- `schemas/openmontage/paid-generation-gate.schema.json`：outcome の各 field に `description`（= Jev instructions）、`recommended_route` に `x-enum-descriptions`（= choice criteria の説明）、outcome 自体に `description`（= `state.brief`：route 定義・input 各項目の意味・「承認はしない」）を追加。特定の答えへ誘導する文言は書かない（`tests/jev-question-design.test.mjs` で機械チェック）
- `src/adapters/jev/jev-adapter.mjs`：`x-enum-descriptions` → criteria、outcome description → `state.brief`、`field_confidence`（question ごとの生値）を AdapterResult に追加、`decisionTypeLoader` 注入（A/B 用）
- `human_review_required` の意味を「route 判定そのものに人の確認が要るか」と明文化（有料生成の承認は常に別途 Human が行うため、有料＝human review 必須の同語反復にしない）

### 実測の手順（Human Required：キーは Human のシェルにのみ存在する）

```
node scripts/poc-calibration.mjs dry-run --questions improved      # ネットワーク無し。Rules First 3 件 / Jev 7 件を確認
node scripts/poc-calibration.mjs run --questions improved --only B1-photoreal-scene-baseline   # smoke：1 リクエスト。実経路（ai SDK→Gateway）が動くことと 0.08 との比較を先に確認
node scripts/poc-calibration.mjs run --questions baseline           # 初回実疎通と同じ汎用 instructions（比較基準）
node scripts/poc-calibration.mjs run --questions improved           # 改善後 question（B1 は smoke と合わせて 2 回になるが許容）
node scripts/poc-calibration.mjs analyze docs/poc/calibration/results/<improved>.json --compare docs/poc/calibration/results/<baseline>.json
```

- 前提：`JEV_PROVIDER=vercel`・`AI_GATEWAY_API_KEY`・`EDL_ALLOW_NETWORK=true` が **Human のシェルに export 済み**（CLI は `.env` を読まない。初回実疎通に使った PowerShell セッションは残っていないので、使うシェルで再 export する）。無ければ exit 4 で止まり何も送らない
- 注意：runner の実経路（`realJevUsable` 通過後の `import('ai')` → `createGateway` → `evaluationModel` → `experimental_evaluate`）は Claude Code セッションでは未実行（キー無し）。smoke の 1 リクエストが失敗したら、その出力（キーは含まれない）を次セッションへ
- 規模：代表 10 ケース（A〜F）。Rules First 3 件は API を呼ばず、Jev 7 件 × 2 variant = 14 リクエスト（Jev 公表単価 $0.042/M input tokens → 合計 1 セント未満の見込み）。429 / 認証系 / 連続 unavailable で即停止
- 結果は `docs/poc/calibration/results/<UTC>-<variant>.json`（secret 混入を保存前に検査）。usage.jsonl にも本番同様に 1 判定 1 行（`attempts[]` に Jev attempt）で残る
- ケース定義と Human expectation（実行前記録）：`docs/poc/calibration/paid-generation-gate.cases.json`

### 判定（実測前の暫定）

- Calibration 分類：**B（question 設計改善で十分）の暫定**。閾値 0.85 / 0.60 は**維持**（実測前の変更は §11 の順序に反する）
- 実測後に見るもの：(1) improved の confidence 分布が baseline より上がるか、(2) 明確ケース（A3・B1・B2）と曖昧ケース（C1・F1）が分離するか、(3) limiting field が特定の question に偏るか（偏るなら閾値でなくその question を直す）、(4) final=human のケースでも `attempts[]` に Jev の provider / model / tokens / cost / confidence / latency が残るか（§19）
- OpenMontage wrapper ready 判定は**実測完了まで保留**（question 設計安定・confidence 挙動理解の 2 条件が未充足）

### 実測結果（第1回、2026-09-19 09:48–09:50 UTC、Human 実行）と `JEV_VERCEL_SDK_ERROR` の原因

**measured fact**（`docs/poc/calibration/results/20260919T09*.json`。統合表示は `node scripts/poc-calibration.mjs analyze docs/poc/calibration/results/*.json`）

| variant | Rules First | Jev ok | Jev 失敗 | confidence（Jev ok） | limiting field |
|---|---|---|---|---|---|
| baseline（description 無し） | 3（A1・A2・D1） | 4（A3・B1・B2・C1） | 2（D2・E1） | min 0.04 / median 0.07 / max 0.12、全件 tier=human | remotion_suitable ×3、paid_generation_required ×1 |
| improved（smoke B1） | — | 1（B1） | 0 | 0.12（tier=human） | human_review_required |
| improved（全体 run） | 2（A1・A2） | 0 | 2（A3・B1） | — | — |

- baseline の outcome は **field 間で矛盾**する（A3：`remotion_suitable=true`・`paid=false` なのに route=`en-generate-hub`。C1：`local_sufficient=false` なのに route=`local`）。route 定義を渡していない以上、当然の結果
- improved B1 は **field 間で整合**（local=false / remotion=false / paid=true / route=en-generate-hub）、field confidence は local 0.94・remotion 0.92・route 1.00・paid 0.76、**human_review_required だけ 0.12**（baseline B1 の limiting は remotion 0.04）。description を書いた field はそのまま上がり、書き方が「組織の判断基準」に依存する field だけが残った
- latency：成功 393〜2743ms（median 528ms）、tokens ≈ 300〜500 in、cost 21〜52 USD micros/件。失敗 4 件はすべて **6840〜7477ms**
- metering（§19）：final=human の全 Jev ok 件で `attempts[]` に `provider=typesafe-ai / model=typesafe-ai/jev / networked=true / usage_known=true / cost` が残った。失敗件は `networked=null / usage_known=false / unknown_usage_attempts=1`（送ったか不明扱い。0 と書いていない）

**`JEV_VERCEL_SDK_ERROR` の根本原因**（コードから確定。`node_modules/ai@7.0.107`・`@ai-sdk/provider-utils` の実体を読んだ）

- AI SDK `experimental_evaluate` は retryable（`APICallError.isRetryable` / `GatewayError.isRetryable` = 408/409/429/5xx）なエラーを既定 `maxRetries=2`・`initialDelay 2000ms`・`backoffFactor 2`（Retry-After 尊重）で再試行し、使い切ると **`RetryError{ reason:'maxRetriesExceeded', errors:[3件], lastError }`** を投げる
- `RetryError` は **`statusCode` を持たない**ため、`classifyGatewayError` の `statusCode` 分岐に入らず末尾の `JEV_VERCEL_SDK_ERROR`（`networked:null`）に丸まっていた。失敗 4 件の 6.8〜7.5s = 2s + 4s の backoff + 3 回分の通信で完全に一致
- 除外できるもの：payload / question 構造（`validateEvaluationInput` は retry の**前**に走り ms で失敗する。同じ B1 payload が 09:48 に成功している。`tests/poc-calibration.test.mjs` で 7 ケースの question 構造が同一であることも固定）、parse 不正（別 reason `JEV_MALFORMED_RESPONSE` になる）、401/403（non-retryable → 1 回目で生のまま throw → `JEV_AUTH_FAILED`/`JEV_FORBIDDEN` に分類される）
- **確定できないもの**：元エラーが 429（Gateway/Jev の rate limit）か 5xx（一時障害）か。`errors[]` を捨てていたので保存結果からは分からない。状況証拠（5 秒間に 6 リクエスト連打の直後から 30 秒以上すべて失敗、Retry-After があれば短縮されるはずの遅延が純粋な backoff 値）は rate limit 寄りだが**推測で確定しない**。分類は §11 の **E（未確定）→ 観測可能性を上げて smoke 1 件で事実取得**

**修正**（repo。core・policy・閾値・Human Gate は無変更）

- `classifyGatewayError`：`RetryError`（duck-typing：`reason` 文字列 + `errors[]`）を **unwrap** して元エラーで分類し直す（429 → `JEV_RATE_LIMITED`、5xx → `JEV_OVERLOADED`、…）。`retry_count = errors.length − 1`（**実カウント**。maxRetries からの推定ではない）、`retry_reason`、`networked:true`（再試行された＝送信済み）を details に付ける。成功時の retry 回数は SDK が公開しないので従来どおり付けない
- safe diagnostic：`error_name`（識別子のみ）・`error_type`（Gateway の `type`、例 `rate_limit_exceeded`）・`status`・`retryable` を details に。message / body / headers / キーは写さない。runner は allowlist で results JSON に `jev.diagnostic` として保存
- runner：retryable 失敗の直後は 5 秒置いて次へ（連打しない。停止条件「429/認証系は即停止・2 連続失敗で停止」は維持）。`analyze` に複数ファイル統合（case_id × variant で最新の成功 record を採用、成功済みは再課金しない）
- tests 127 → 133

**Human Required（再実測。使うシェルで `JEV_PROVIDER=vercel`・`AI_GATEWAY_API_KEY`・`EDL_ALLOW_NETWORK=true` を再 export）**

```
node scripts/poc-calibration.mjs run --questions improved --only A3-motion-lower-third
# ↑ 1 リクエスト。失敗しても今度は reason / status / retry_count / error_name が results に残る。成功したら続けて：
node scripts/poc-calibration.mjs run --questions improved --only B2-photoreal-image,C1-boundary-scene-unspecified,D2-motion-with-photoreal-jev,E1-product-shot-reference,F1-underspecified
node scripts/poc-calibration.mjs run --questions baseline --only D2-motion-with-photoreal-jev,E1-product-shot-reference,F1-underspecified
node scripts/poc-calibration.mjs analyze docs/poc/calibration/results/*.json
```

合計 9 リクエスト（improved 6・baseline 3）。既に成功している baseline 4 件・improved B1 は再実行しない（`analyze` が統合する）。

### 判定（第1回実測後・暫定のまま）

- **Calibration 分類：B（question 設計改善で十分）の暫定**、n=1。改善が狙った field（local / remotion / route）はそのまま上がり、outcome の整合性も回復した。ただし improved の残り 6 件が未測定
- **`human_review_required` は別扱いの候補（D：一部 field は Jev 向きでない）**。「人が route 判定を確認すべきか」は資産の事実ではなく組織の許容度に依存し、input に無い。improved で残り 6 件も同 field が limiting なら、この field は Jev に訊かず他 4 field と confidence から決定的に導く（follow-up タスク）を検討する。**今回は wording を変えない**（改善版の A/B を汚さない）
- aggregate（min）・閾値（0.85 / 0.60）：**変更しない**。improved 残 6 件が揃うまで判断材料不足。alt aggregate 列は解釈用のまま
- OpenMontage wrapper ready：**保留**（improved 実測完了・error 原因の実測確認が未了）
