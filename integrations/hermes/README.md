# Hermes（Mac mini 常駐 Agent・設計のみ・未導入）から使う

正本：Vault `AI-Workflow-System/07_project-kits/AI開発環境改善マスタープラン_Hermes常駐Agent導入設計_2026-08-30.md`。

- Hermes は Vault に対して read-only（同正本 §6–7）。Decision Layer も Hermes から **CLI / SDK を読み取り用途で呼ぶだけ**
- 想定 decision_type：どの Agent / AI社員へ渡すか（agent-route・未定義）／Local で処理できるか（local adapter）／Cloud LLM が要るか／Human へ上げるか
- AI-Company V1 §13 Trigger Matrix の「Hermes 判定 → 本体が下書き」「送信は必ず Human」は tier=human の扱いと一致する
- Hermes 導入時に `src/adapters/local/` を実装し、Mac mini のローカルモデルを probabilistic Adapter として登録する（core は変更しない）

## Browser automation / Computer Use（将来・未実装）

連続する小さな行動判断（click / type / back / continue / retry / stop / tool選択 / sub-agent選択）を `agent-action-micro`（予約）として Decision Layer に流す構想。
Claude Code 専用ではなく Hermes・ブラウザ自動化・Computer Use・将来の Agent が同じ CLI / SDK を使う。
`stop` や「人に聞く」に相当する結果は tier=human に写像し、Human-only 操作（送信・購入・ログイン・本番）を Jev が承認することはない。詳細は `docs/roadmap-future-use-cases.md` §1。
