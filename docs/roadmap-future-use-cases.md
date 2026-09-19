# Roadmap: 将来ユースケース（2026-09-19 追記・いずれも未実装）

MA-30 土台構築後に追加確認した Jev の有力用途を、Decision Layer の正式な将来ユースケースとして記録する。
本 docs は「名前と責務境界の予約」であり、schema・rules・Adapter・接続は作っていない。
共通原則：**Jev は判定補助であり、Safety 解除・承認・Human-only 置換はどの用途でも行わない。**

| # | 用途 | 予約した decision_type | 呼び出し元 | 実装状態 |
|---|---|---|---|---|
| 1 | Browser / Computer Use 向け micro decision | `agent-action-micro` | Hermes・ブラウザ自動化・Computer Use・将来Agent | 予約のみ |
| 2 | Context Relevance Filter | `context-relevance` | Claude Code・Cursor・Hermes（上位LLM投入前） | 予約のみ |
| 3 | Input / Output Guard 補助 | `io-guard-assist` | 全呼び出し元 | 予約のみ（禁止キー先置き） |
| 4 | Post-Execution Verification | `post-execution-verify` | 全呼び出し元 | 予約のみ |

予約は `schemas/common/decision-types.json` の `reserved_decision_types`。schema が無いため `decide()` は `UNKNOWN_DECISION_TYPE` を返す（誤って動かない）。

## 1. Browser / Computer Use 向け micro decision

- 対象：click / type / back / continue / retry / stop / tool選択 / sub-agent選択 のような、連続して大量に発生する小さな判断
- 位置づけ：上位LLMに毎回聞くほどではない判断を、Registry が絞った候補（tool / sub-agent）の中から型付きで選ぶ
- 境界：`stop`・「人に聞く」は tier=human へ写像。送信・購入・ログイン・本番操作は Human-only のまま（Safety台帳§4・§5-1）
- Claude Code 専用にしない。Hermes・ブラウザ自動化・Computer Use・将来Agent が同じ CLI / SDK を使う（`integrations/hermes/README.md`）

## 2. Context Relevance Filter

- 対象：ログ・tool result・Skill情報・過去 context を上位LLMへ渡す**前**に「今のタスクに必要か／残すか／削除可か／優先度」を高速判定し、投入量を減らす
- 思想：**要約AIではない**。Decision Layer → relevance decision → 必要な情報だけ LLM へ、という仕分け
- 既存との関係：Vault の `context-diet` Skill（S/M/L・読む範囲を先に決める運用規範）とは**補完関係**。context-diet は「人とAIが何を読むか決める規範」、本用途は「渡す直前の機械的な仕分け」。置換しない
- 境界：削除判定は「LLM へ渡さない」だけで、Vault・ログの実体を消す権限は持たない

## 3. Input / Output Guard 補助

- 対象：PII 含有可能性／機密情報含有可能性／suspicious input／suspicious output／LLM 出力品質／security alert triage／escalation 推奨
- 構造：**Jev → 「怪しい可能性あり」→ 既存 Safety / Human へ Escalate**。検知と推奨だけ
- 禁止：Jev 判定だけで Safety 解除・承認・ブロック解除を行わない。`policies/safety/human-only.json` の `forbidden_outcome_keys` に `safety_cleared / guard_released / unblock / release_block / allow_execution` を先に置き、outcome に現れたら `HumanGateViolationError` で停止する
- 既存との関係：Hook（guard-*.js）・deny・autoMode hard_deny・en-generate-hub の承認チェーンが最終安全機構。本用途はその**手前の補助**

## 4. Pre-Decision / Execution / Post-Execution Verification

- Decision Layer の責務は **Pre-Decision**（現在の実装範囲）と **Post-Execution Verification**（将来）。**Execution は外**（既存 Harness / App / Skill が既存ゲートを通して実行）
- Post-Execution の verdict：`PASS / RETRY / REVIEW / ESCALATE / HUMAN`。「次に誰が見るか」を表すだけで、HUMAN / ESCALATE を confidence で PASS に変えることはできない（`force_human_when_outcome_keys` と同じ扱いにする）
- 既存との対応：Product Hub pull-plan（auto / claude / human）、en-sns-hub（confirmed / needs_review）、Codex / independent-inspector の検品と語彙を写像できるようにする（既存側の語彙は変えない）
- 図と責務説明は `docs/architecture.md` §8

## 仕様に固定しない情報

レイテンシ（ms）・上位モデル比の速度／価格・hallucination 率・ベンチマーク順位・選択肢数上限・学習手法（RLCD 等）の詳細は**ベンダー公表値**であり変更され得るため、Decision Layer の仕様・閾値・chain には入れない。参考値を残す場合は出典付きで本 docs に置くだけにする。現時点で出典確認済みの値は無いため記録していない。

## 実装へ進める条件（この順を崩さない）

1. GitHub repo 作成＋push、skill-sync（Human-only）
2. Jev 実API仕様・キー取得 → `direct` Provider 実装（`src/adapters/jev/jev-provider-interface.mjs` の契約内）
3. `paid-generation-gate` の本接続（OpenMontage wrapper）と usage.jsonl 実測
4. その後に本 docs の 1〜4 を1件ずつ schema 化（`reserved_decision_types` → `decision_types` へ移す）
