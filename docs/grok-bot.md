# Grok Bot（EN司令塔）から Task Hub を使う（2026-11-13・MA-24）

EN司令塔は受付・整理・依頼・進捗確認・報告の窓口。実行の判断（権限・承認・監査）は Mac の Task Hub と Decision Layer、承認は Mac の端末の Human、実務の AI 処理は Hermes、開発は Claude Code。**新しい司令塔の Bot は作らない。MCP の登録は作り直さない**（登録済み・2026-11-13 に往復の検収済み）。

接続：Remote MCP（VPS の受け口・Bearer）。道具は `submit_task`・`get_task_status`・`list_capabilities` の 3 つ。依頼はすべて「提案」で、VPS では何も実行しない。Mac が 5 分ごとに取り、分類・承認・実行して結果の板へ返す。

## 1. EN司令塔に許している依頼（2026-11-13 の本番の設定）

source `grok-commander`・business `e-nexus` だけ（VPS の鍵の intents と Mac の config の 2 重。VPS の business の制限は §16 の適用の後に 3 重）。

| intent | 実装 | 本番 | 外への副作用 | AI 課金 | Human 承認 | 範囲 | 返し方 |
|---|---|---|---|---|---|---|---|
| `status.query` | 済 | 稼働（11-13 に往復検収） | なし（読むだけ） | なし | 不要（auto） | Mac の監視の要約の水準と件数。`detail: true` で区分の水準・Task Hub と Hermes の件数 | `get_task_status` の `result` |
| `task.status` | 済 | 稼働 | なし | なし | 不要（auto） | 自分（EN司令塔）が出した e-nexus の依頼だけ。`view` で一覧（recent・承認待ち・失敗・Hermes） | 同上 |
| `report.morning` | 済 | 稼働 | なし | なし | 不要（auto） | e-nexus の記録（メール・予定の要約・メモ）と稼働状況・承認待ち・Hermes の件数から決まった文面 | 同上（`result.text`） |
| `note.record` | 済 | 稼働 | Mac の手元のメモに 1 件 | なし | 不要（ai_check＝Decision Layer が candidate の時だけ無人） | e-nexus のメモ（500 字・`case_ref` 任意） | 同上（`recorded: true`） |
| `hermes.task` | 済 | 稼働（承認の後に Human が 1 件ずつ実行） | Hermes が 1 回動く（Mac の中だけ・sandbox） | **あり**（Haiku・1 件で API 2〜4 回） | **毎回必要**（Mac の端末で全文を読んで確認コード） | 依頼の本文の範囲だけ。Hermes が読めるのは依頼の file と状態の要約だけ | 同上の `result.hermes`（waiting → running → done／failed＋summary） |

許していない（Human の承認が無い限り足さない）：`mail.digest.ingest`・`calendar.digest.ingest`（§4）・メールの送信／削除／移動／既読・予定の作成／変更／削除（handler がそもそも無い）・E-STEP・個人の business。

## 2. 呼び方の例（submit_task の arguments）

- 状況：`{ "idempotency_key": "grok-status-20261113-0900", "business": "e-nexus", "intent": "status.query", "params": { "detail": true } }`
- 自分の依頼の一覧：`{ …, "intent": "task.status", "params": { "view": "recent", "limit": 10 } }`（承認待ちは `"view": "awaiting_approval"`、Hermes の結果は `"view": "hermes"`）
- 1 件の状態：`{ …, "intent": "task.status", "params": { "task_ref": "<前に出した idempotency_key>" } }`
- 朝のまとめ：`{ …, "intent": "report.morning", "params": {} }`
- メモ：`{ …, "intent": "note.record", "params": { "text": "現場 A は来週の金曜に図面の最新版", "case_ref": "case-a" } }`
- Hermes の業務：`{ …, "intent": "hermes.task", "params": { "title": "週報の下書き", "body": "e-nexus のメモから今週の要点を 5 行に" } }` → 承認待ち（Human が Mac で承認・実行するまで動かない）

決まり：`idempotency_key` は毎回新しい（同じ key の出し直しは前の結果を返すだけ）。結果は 1〜5 分後に `get_task_status`（`task_ref`＝idempotency_key）。`params`・`summary` に秘密・パスワード・鍵を入れない（鍵の形の値は依頼ごと拒否される）。

## 3. Grok Bot の側の設定（Human）

- **Ask First の候補**：`submit_task`＝Ask First を推奨（`hermes.task` は Mac で承認されるまで動かないが、課金の依頼を Bot が勝手に積まないため。読むだけの依頼を Bot に自由に出させたい時は Auto でもよい＝VPS と Mac が intent・business を絞っている）。`get_task_status`・`list_capabilities`＝Auto（読むだけ・自分の依頼だけ）
- コネクタ（MCP）はアカウントの他の Bot からも見える場合がある：使えるのは EN司令塔の鍵に許した intent・business だけ（VPS と Mac の 2 重）。他の Bot に使わせない時は、その Bot の Computer & Apps で MCP を外す
- EN司令塔の指示文に足す候補（Grok の画面で Human が貼る）：
  > E-NEXUS Task Intake（MCP）を使う時は business を必ず "e-nexus" にする。idempotency_key は「grok-<用途>-<日時>」のように毎回新しく作る。submit_task の後は 1〜5 分待って get_task_status で結果を読み、state と result をそのまま報告する（推測で補わない）。hermes.task は Human の承認が要り、承認されるまで実行されないことを伝える。秘密・パスワード・個人のメールアドレスを params に入れない。メールの送信・削除・予定の変更は依頼しない（受け付けない）。

## 4. Gmail・カレンダーの要約を渡す（**未接続**・Human の承認が要る）

Grok Bot は Gmail・Google カレンダーに接続済み。新しい OAuth・有料 API は作らない。Bot が自分で読んだ要約を Task Hub に「記録として」渡す形（Mac はメール・予定を操作しない）。

| 段 | 内容 | 状態 |
|---|---|---|
| Mac の受け | `mail.digest.ingest`（件名 120 字・差出人の表示名 60 字・分類・期限）・`calendar.digest.ingest`（題名・時刻・case_ref）→ `report.morning` が返信待ち・重要・今日明日の予定・重なりをまとめる | 実装・試験済み（handler・保持・重複除去） |
| Mac の許可 | config の `grok-commander.intents` に 2 つを足す | **Human の承認**（個人の情報＝送信者名・件名が Mac に残る範囲の拡大） |
| VPS の許可 | `connect-from-mac.sh … --intake --source grok-commander --intents <今の 5 つ>,mail.digest.ingest,calendar.digest.ingest --businesses e-nexus` | **Human**（ssh） |
| Grok のルーチン | 朝のルーチンに下の指示を足す | **Human**（Grok の画面） |

ルーチンの指示の候補（承認の後に貼る）：
> 毎朝 7:30、e-nexus の Gmail で過去 24 時間の受信を分類し（important・reply_needed・info・spam）、submit_task で intent "mail.digest.ingest"、business "e-nexus"、params.items に { id（Gmail のメッセージ ID を英数字で 64 字以内）, received_at（ISO）, account（"gmail"）, category, from_label（表示名だけ・アドレスは入れない）, subject（120 字まで）} を最大 30 件ずつ出す（30 件を超えたら別の idempotency_key で分ける）。同じく今日と明日の予定を intent "calendar.digest.ingest" の params.events（id・start・end・title・case_ref は案件の記号があれば）で出す。最後に report.morning を出して結果の text を報告する。メールの送信・削除・既読・予定の変更はしない。

上限：params は 14,000 byte まで（日本語のメール 1 件 約 380 byte＝**約 30 件で 1 封**）。鍵の形の値が 1 つでも混ざると 1 封ぶん全部拒否（`docs/task-hub.md` §2）。

## 5. 確かめ方（Claude Code）

`node scripts/task-hub.mjs list`（Mac の task）・`node scripts/task-hub-cycle.mjs`（手で 1 回）・`node scripts/task-intake-edge-check.mjs`（入口の 11 項目）。往復の検収は Human が EN司令塔に依頼して task_ref を伝える。

## 6. 普段の言葉での使い方（2026-11-13）

「今使える」＝EN司令塔に許可済みで本番で動く。「承認の後」＝実装・試験は済み、Human の承認（許可フォルダ・EN司令塔への公開・資格情報）の後に使える。

| したいこと | EN司令塔への言い方の例 | 中身（intent） | 状態 |
|---|---|---|---|
| Mac mini の状態 | 「Mac の状況を詳しく教えて」 | `status.query {detail:true}` | 今使える |
| Hermes の状態 | 「Hermes の業務はどうなってる？」 | `status.query {detail:true}` の hermes・`task.status {view:"hermes"}` | 今使える |
| 承認待ちの一覧 | 「承認待ちは？」 | `task.status {view:"awaiting_approval"}` | 今使える（承認は Mac の端末） |
| 朝のまとめ | 「朝のまとめを出して」 | `report.morning` | 今使える |
| メモ | 「現場A のメモ：図面は来週」 | `note.record {text, case_ref}` | 今使える |
| 現場資料の検索 | 「現場A の平面図を探して」 | `dropbox.search` | 承認の後（Dropbox の設定・許可フォルダ・公開） |
| 現場カルテの確認 | 「C-001 のカルテの注意事項は？」 | `karte.get {section:"safety"}`・`karte.report` | 承認の後 |
| 現場カルテへの追記 | 「C-001 の搬入経路に、西側から入れると追記して」 | `karte.append` | 承認の後 |
| 見積の AI タブの作成 | 「現場A の見積を見て、AI_案2 に新しい見積を作って」 | `estimate.ai.create`（毎回 Mac で承認） | 承認の後 |
| AI タブの修正 | 「AI_案2 の足場の数量を 300 にして」 | `estimate.ai.edit`（毎回 Mac で承認） | 承認の後 |
| 工程表の予定 | 「工程表で現場A の予定は？」 | `schedule.read {query}` | 承認の後 |
| 工程表の臨時バックアップ | 「今の工程表をバックアップして」 | `schedule.backup`（完了は保存と検証の後だけ） | 承認の後 |
| バックアップの履歴 | 「工程表のバックアップの一覧」 | `schedule.backup.list` | 承認の後 |
| 昨日の工程表 | 「昨日の工程表を出して」 | `schedule.restore {at}`（別の file） | 承認の後 |
| ドコモメール | 「ドコモの新着は？」 | （読み取りの取得は実装済み・資格情報と取り込みの決定の後） | 承認の後 |

Human が「人間が作ったタブ 1 と 2 は触らないで」と言わなくても、AI が直せるのは AI が作った `AI_` のタブだけ（docs/dropbox-business.md §6）。
