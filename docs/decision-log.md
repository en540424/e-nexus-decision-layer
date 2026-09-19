# Decision Log

| 日付 | 決定 | 理由 | 代替案 |
|---|---|---|---|
| 2026-09-19 | repo 名を `e-nexus-decision-layer` とし Jev 名を含めない | Jev は Adapter の1つ。本体を Jev 依存にしないため | `jev-gateway` 等 |
| 2026-09-19 | Vault 外の独立 repo（`C:\Users\envie\e-nexus-decision-layer`）に置く | Claude Code 専用にしない。Cursor / Hermes / 販売App から同じ CLI・SDK を使う。Vault は正本（設計・判断ログ）だけを持つ | Vault 内 `app/`、en-generate-hub 内サブモジュール |
| 2026-09-19 | Node ESM・依存ゼロ・`node --test` | en-generate-hub / en-product-hub と同じ idiom。install 不要で許可プロンプトを増やさない | TypeScript + vitest |
| 2026-09-19 | deterministic rules を chain の先頭に固定 | 監査で見つかった既存判断（Advisor 13条件・AI-Company §6 表・Plan 判定表）はほぼ決定的。Jev は「rules で解けない残り」だけに使う | Jev を先に呼ぶ |
| 2026-09-19 | tier 語彙を auto / review / human | en-product-hub の pull-plan（auto / claude / human）と概念を揃える | high / medium / low |
| 2026-09-19 | outcome から承認キーを構造的に排除（forbidden_outcome_keys + closed schema + test） | 「Human Gate を弱めない」を主張ではなく機械で担保する | ドキュメントで禁止するだけ |
| 2026-09-19 | 高コストLLM provider（anthropic / openai / google）の Adapter は `allow_paid_adapters=true` のときだけ chain に残す。**Jev は対象外**（既定で呼ぶ） | Jev の役割は「高額AIを呼ぶ前の低コストGate」。Cost Gate で止めると存在意義が消える（Advisor指摘で修正）。LLM は Medium confidence の再判定用なので opt-in | Jev も cost-gate する |
| 2026-09-19 | 「Humanへ上げる」フラグ名を policy（`force_human_when_outcome_keys`）で一元管理 | ドメインごとに語彙が違う（`human_review_required` / `needs_human_review` / `human_required`）。engine にハードコードすると schema-only の decision_type で human 強制が効かない（Advisor指摘で修正） | 語彙を1つに統一して各schemaを書き換える |
| 2026-09-19 | `__mock` は `allowMockControl=true`（テスト専用）のときだけ有効 | 本番入力から Mock の経路を操作されないため | schema から `__mock` を外す |
| 2026-09-19 | PoC は「有料生成直前の Decision Gate」 | docs/poc-paid-generation-gate.md 参照。Model Router は rules で完結するため Jev PoC に不向き | Model Router / Skill Router |
| 2026-09-19 | metering の通貨単位を USD micros | en-generate-hub budget.mjs と同一単位で転記時の桁ズレ防止 | USD float |
| 2026-09-19 | `EN-Volt` は登録しない | Vault・ホームディレクトリのどこにも実体が確認できなかった（推測で作らない） | 空エントリ登録 |
| 2026-09-19 | Jev Adapter を「変換」と「経路（Provider）」に分離。`JEV_PROVIDER`＝direct / vercel / cloudflare | Adapter が env 直読み・direct 固定だと経路追加で decide() を書き換えることになる。Provider 1ファイル追加で済む形に | Adapter を経路ごとに複製 |
| 2026-09-19 | 将来ユースケース4件（micro decision / context relevance / I/O guard 補助 / post-execution verify）は decision_type 名の**予約のみ**（schema・rules・Adapter は作らない） | 名前と責務境界を先に固定し、実装時に既存設計と矛盾しないようにする。特に guard 補助は「解除を返せない」禁止キーを先に置く | 今 schema まで作る |
| 2026-09-19 | ベンダー公表の性能値（ms・価格比・選択肢上限・学習手法等）を仕様に入れない | 変更され得る値に本体を依存させない。閾値は実測で決める | docs に数値を転記 |
| 2026-09-19 | Direct Provider は `@typesafe-ai/sdk` を採用せず、Node 20+ の `fetch`/`AbortController` で自前実装 | 依存ゼロ方針（`package.json`に依存無し）を維持するため。SDK既定値（timeout 10s・retry 2回・backoff・Retry-After尊重）は自前実装で再現 | SDK採用（依存追加を許容） |
| 2026-09-19 | outcome schemaのフィールド型からJev questionsへ自動写像（boolean→noul、enum文字列→choice、2〜10段の整数→score）。対応不能な型は`JEV_UNSUPPORTED_OUTCOME_FIELD`で止める | decision_typeごとにJev変換コードを書き足す設計だとAdapterが肥大化し、型の対応漏れを推測で埋めるリスクが出る。汎用写像＋明示的な非対応エラーの方が安全 | decision_typeごとに専用マッピング関数を書く |
| 2026-09-19 | 全体confidence = 各questionのconfidenceの最小値（保守側で合成） | 一部のquestionだけ確信度が高くても、他が不確かなら全体をhuman行きにする。楽観的な平均・最大値は誤ってautoにする方向に倒れやすい | 平均値・重み付け合成 |
| 2026-09-19 | noulのconfidenceを`\|2*noul-1\|`として独自導出（公式は返さない） | 公式値が無い以上ここで作るしかない。0.5付近＝五分五分で低confidence、0/1付近＝高confidenceという直感に一致させた | confidence常に1.0固定（楽観） |
