# 作業ログ運用（EN-Knowledge-Vault共通・cross-repo）

このファイルはEN-Knowledge-Vaultが配布する共通ルールです。**このrepo内で編集しないでください。**
正本は `EN-Knowledge-Vault/AI-Workflow-System/01_harness/templates/en-devlog-cross-repo.md` で、
`skill-sync.ps1 -Group AppRepoClaude` により各repoへ配布されます（MA-19 / 2026-08-17導入）。

判断基準の詳細な正本は `EN-Knowledge-Vault/AI-Workflow-System/01_harness/作業ログ自動運用_正本.md` です。
ここには全文を複製しません（二重管理を避けるため）。

---

## 1. 作業ログはVaultへ書く

このrepoでの開発作業の記録先は、**このrepoの中ではなくEN-Knowledge-Vault**です。

- 保存先：`EN-Knowledge-Vault/02_Development-Logs/YYYY-MM/`
- ファイル名：`YYYY-MM-DD_プロジェクト名_テーマ.md`
- frontmatter：`schema: ai-note-v1` / `type: dev_log` / `created`（当日固定）/ `updated` / `created_source: Claude Code` / `date_status: confirmed` / `project` / `tags`
- 使用するSkill：`common-dev-log`（`~/.claude/skills/` と本repoの `.claude/skills/` に同一版が配布されています）

**相対パスで `02_Development-Logs/` と書かないでください。** このrepoをrootにしている場合、
相対パスはこのrepo内を指し、Vaultには残りません。必ずVaultの絶対パスで書き込みます。

## 2. ログ要否はユーザー指示を待たずに判定する

まとまった作業の区切り（実装完了・commit・実機確認完了・エラー原因と解決の確定・作業テーマ切替・
セッション移動・作業中断・次回再開地点の確定など）で、Claude Code本体が自動的に要否を判定します。
ユーザーが「ログを書いて」と言うのを待ちません。

**ログ必須**（作業ログ自動運用_正本§3-1の抜粋）：コード実装／設計変更／正本・ルール・Skillの変更／
外部設定の変更／Git commit・pushを行った／実機確認が完了した／複数ファイルを変更した／
重要な調査結果や判断を確定した／次回AIの現在地判断へ影響する。

**ログ不要でよい例**（同§3-2）：読み取りだけの短い確認／単純な質問への回答／誤字1か所の軽微修正／
何も変更せず終了した確認。**不要と判断した場合も、完了報告に `作業ログ：不要（理由：〜）` を1行記載します。**

## 2-1. 「正本変更禁止」「no Vault」は作業ログ不要を意味しない（2026-09-12追加）

「Vaultの正本を変更しない」「no Vault」という指示は、**正本・企画・設計書・台帳を書き換えない**という意味です。
`02_Development-Logs/` への開発ログの作成・追記は正本変更ではなく、**この指示があっても必ず行います**。
作業ログまで不要にする場合は、ユーザーが「作業ログ不要」と別途明示します。

また、監査・レビュー・設計判断だけのセッション（ファイル変更0件）も作業ログの対象です。
セッションを終える前・Human確認待ちで止める前に、ログ要否の確認→既存ログ検索→記録→commit/push結果の記載を
本体が必ず行います（作業ログ自動運用_正本§18-3）。Vaultを作業ディレクトリに持たないセッションでは、
このrepo内に置き場を作らず、完了報告に「Vault側ログ未作成」と明記して次のVaultセッションで補完します。

## 3. mvp-tasks / CURRENT_STATE の更新は作業ログではない

`.claude/mvp-tasks.md`・`CURRENT_STATE.md`・`AI_CONTEXT.md` 等の「現在地docs」を更新しても、
作業ログを書いたことにはなりません。両者は目的が違います（現在地docs＝今どうなっているか／
作業ログ＝何が起きたか・なぜそう判断したか）。両方が必要です。

## 4. 新規作成か追記か

同じ日・同じプロジェクト・同じ作業目的・同じ成果物なら**既存ログへ追記**します。
別プロジェクト・別テーマ・別成果物なら、同じ日でも**新規ファイル**にします。
1日1ファイルにまとめる運用は採用していません（作業ログ自動運用_正本§2）。

## 5. commit前の機械チェック

このrepoの `.claude/hooks/guard-devlog-before-commit.js` が、`git commit` の実行前に
Vault側の当日・前日ログの有無を機械的に確認します。

- コード（`src/`・`app/`・`lib/`・`scripts/` 等、`.ts`/`.tsx`/`.js`/`.mjs`/`.py` 等）、
  `.claude/` 配下の設定・Hook・SKILL.md、`app.json`/`eas.json`/`package.json` の変更が
  staged にあるのにVault側ログが無い場合は **deny（commit拒否）** されます
- ドキュメントのみ（`*.md`）・`package-lock.json` のみの変更は通過します
- 拒否された場合の対応は「Vaultへログを作成・追記してから再commit」または
  「ログ不要と判断できるなら対象ファイルをstagedから外す」のいずれかです。
  Hookを無効化したり迂回したりしないでください（設定変更はHuman-only）

## 6. Vaultを触るときの安全ルール

作業ログのためにVaultへ書き込む場合も、Vaultの運用ルールが適用されます。

- **禁止**：`git add .` / `git add -A`（Vault・本repoとも。必ず明示パスでstageする）
- **禁止**：無関係なuntrackedファイルのstage・削除、`reset` / `restore` / `stash` / `clean`
- Vaultには進行中の無関係な作業が存在する前提で扱い、今回作成・更新したログだけをstageする
- 既存ノートの `created` を書き換えない
- Vaultのcommitと本repoのcommitは別々に行う（混ぜない）

## 7. 迷ったら

`EN-Knowledge-Vault/AI-Workflow-System/01_harness/作業ログ自動運用_正本.md` を確認してください。
このファイルと正本が矛盾する場合は、**正本が優先**です。
