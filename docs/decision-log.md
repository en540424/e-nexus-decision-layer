# Decision Log

| 日付 | 決定 | 理由 | 代替案 |
|---|---|---|---|
| 2026-09-19 | repo 名を `e-nexus-decision-layer` とし Jev 名を含めない | Jev は Adapter の1つ。本体を Jev 依存にしないため | `jev-gateway` 等 |
| 2026-09-19 | Vault 外の独立 repo（`C:\Users\envie\e-nexus-decision-layer`）に置く | Claude Code 専用にしない。Cursor / Hermes / 販売App から同じ CLI・SDK を使う。Vault は正本（設計・判断ログ）だけを持つ | Vault 内 `app/`、en-generate-hub 内サブモジュール |
| 2026-09-19 | Node ESM・依存ゼロ・`node --test` | en-generate-hub / en-product-hub と同じ idiom。install 不要で許可プロンプトを増やさない | TypeScript + vitest |
| 2026-09-19 | deterministic rules を chain の先頭に固定 | 監査で見つかった既存判断（Advisor 13条件・AI-Company §6 表・Plan 判定表）はほぼ決定的。Jev は「rules で解けない残り」だけに使う | Jev を先に呼ぶ |
| 2026-09-19 | tier 語彙を auto / review / human | en-product-hub の pull-plan（auto / claude / human）と概念を揃える | high / medium / low |
| 2026-09-19 | outcome から承認キーを構造的に排除（forbidden_outcome_keys + closed schema + test） | 「Human Gate を弱めない」を主張ではなく機械で担保する | ドキュメントで禁止するだけ |
| 2026-09-19 | 有料 provider の Adapter は `allow_paid_adapters=true` のときだけ chain に残す | Decision Layer 自身の判定コストも Cost Gate の対象。既定は無料経路のみ | 常に全 Adapter を試す |
| 2026-09-19 | PoC は「有料生成直前の Decision Gate」 | docs/poc-paid-generation-gate.md 参照。Model Router は rules で完結するため Jev PoC に不向き | Model Router / Skill Router |
| 2026-09-19 | metering の通貨単位を USD micros | en-generate-hub budget.mjs と同一単位で転記時の桁ズレ防止 | USD float |
| 2026-09-19 | `EN-Volt` は登録しない | Vault・ホームディレクトリのどこにも実体が確認できなかった（推測で作らない） | 空エントリ登録 |
