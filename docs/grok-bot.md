# Grok Bot（EN司令塔）から Task Hub を使う（2026-11-13・MA-24）

EN司令塔は受付・整理・依頼・進捗確認・報告の窓口。実行の判断（権限・承認・監査）は Mac の Task Hub と Decision Layer、承認は Mac の端末の Human、実務の AI 処理は Hermes、開発は Claude Code。**新しい司令塔の Bot は作らない。MCP の登録は作り直さない**（登録済み・2026-11-13 に往復の検収済み）。

接続：Remote MCP（VPS の受け口・Bearer）。道具は `submit_task`・`get_task_status`・`list_capabilities` の 3 つ。依頼はすべて「提案」で、VPS では何も実行しない。Mac が 5 分ごとに取り、分類・承認・実行して結果の板へ返す。

## 1. EN司令塔に許している依頼（2026-11-13 の本番の設定）

source `grok-commander`・business `e-nexus` だけ（VPS の鍵の intents と Mac の config の 2 重。VPS の business の制限は §16 の適用の後に 3 重）。

| intent | 実装 | 本番 | 外への副作用 | AI 課金 | Human 承認 | 範囲 | 返し方 |
|---|---|---|---|---|---|---|---|
| `status.query` | 済 | 稼働（11-13 に往復検収） | なし（読むだけ） | なし | 不要（auto） | Mac の監視の要約の水準と件数。`detail: true` で区分の水準・Task Hub と Hermes の件数 | `get_task_status` の `result` |
| `task.status` | 済 | **稼働（11-16 に往復検収済み）**（11-15 に本番で 2 回失敗 → 11-16 に直し、EN司令塔から `{}`・`pending`・`failed`・`hermes` の 4 件が succeeded。§7） | なし | なし | 不要（auto） | 自分（EN司令塔）が出した e-nexus の依頼だけ。`view` で一覧（recent・承認待ち・失敗・成功・Hermes）。params なしは recent | 同上 |
| `report.morning` | 済 | 稼働 | なし | なし | 不要（auto） | e-nexus の記録（メール・予定の要約・メモ）と稼働状況・承認待ち・Hermes の件数から決まった文面 | 同上（`result.text`） |
| `note.record` | 済 | 稼働 | Mac の手元のメモに 1 件 | なし | 不要（ai_check＝Decision Layer が candidate の時だけ無人） | e-nexus のメモ（500 字・`case_ref` 任意） | 同上（`recorded: true`） |
| `hermes.task` | 済 | 稼働（承認の後に Human が 1 件ずつ実行） | Hermes が 1 回動く（Mac の中だけ・sandbox） | **あり**（Haiku・1 件で API 2〜4 回） | **毎回必要**（Mac の端末で全文を読んで確認コード） | 依頼の本文の範囲だけ。Hermes が読めるのは依頼の file と状態の要約だけ。`kind:"ops_review"`（2026-11-18）は Task Hub の状況（件数・state・code だけ）を添えて、失敗の分類・Human 待ち・次の安全な作業を返す | 同上の `result.hermes`（waiting → running → done／failed＋summary）。`task.status {view:"hermes"}` は新しい 5 件の要約の頭も返す |

許していない（Human の承認が無い限り足さない）：`mail.digest.ingest`・`calendar.digest.ingest`（§4）・メールの送信／削除／移動／既読・予定の作成／変更／削除（handler がそもそも無い）・E-STEP・個人の business。

## 2. 呼び方の例（submit_task の arguments）

- 状況：`{ "idempotency_key": "grok-status-20261113-0900", "business": "e-nexus", "intent": "status.query", "params": { "detail": true } }`
- 自分の依頼の一覧：`{ …, "intent": "task.status", "params": { "view": "recent", "limit": 10 } }`（承認待ちは `"view": "awaiting_approval"`、失敗は `"view": "failed"`、終わった依頼は `"view": "succeeded"`、Hermes の結果は `"view": "hermes"`。`"params": {}` は recent と同じ。`limit` は 1〜20 の数）
- 1 件の状態：`{ …, "intent": "task.status", "params": { "task_ref": "<前に出した idempotency_key>" } }`
- 朝のまとめ：`{ …, "intent": "report.morning", "params": {} }`
- メモ：`{ …, "intent": "note.record", "params": { "text": "現場 A は来週の金曜に図面の最新版", "case_ref": "case-a" } }`
- Hermes の業務：`{ …, "intent": "hermes.task", "params": { "title": "週報の下書き", "body": "e-nexus のメモから今週の要点を 5 行に" } }` → 承認待ち（Human が Mac で承認・実行するまで動かない）
- Hermes に運用の見直しを頼む（2026-11-18）：`{ …, "intent": "hermes.task", "params": { "title": "運用の見直し", "body": "失敗した作業の原因と、承認待ちと、次に安全にできる作業を整理して", "kind": "ops_review" } }`（課金あり・毎回 Mac で承認。状況は承認の後に Mac が添える＝Bot は状況を本文に書かなくてよい）

決まり：`idempotency_key` は毎回新しい（同じ key の出し直しは前の結果を返すだけ）。結果は 1〜5 分後に `get_task_status`（`task_ref`＝idempotency_key）。`params`・`summary` に秘密・パスワード・鍵を入れない（鍵の形の値は依頼ごと拒否される）。

**断られた時（2026-11-16）**：`get_task_status` の `result` が `state: "rejected"`／`"failed"` で `code` が `params_…` の時は、`result.hint` にその intent の正しい params の形が 1 行で入る（台帳に書いた決まった文＝依頼の中身は混ざらない）。Bot は hint の形に直して、**新しい** idempotency_key で出し直す。params に台帳に無い key（例：`status`・`filter`）を足すと `params_invalid`。

## 3. Grok Bot の側の設定（Human）

- **Ask First の候補**：`submit_task`＝Ask First を推奨（`hermes.task` は Mac で承認されるまで動かないが、課金の依頼を Bot が勝手に積まないため。読むだけの依頼を Bot に自由に出させたい時は Auto でもよい＝VPS と Mac が intent・business を絞っている）。`get_task_status`・`list_capabilities`＝Auto（読むだけ・自分の依頼だけ）
- コネクタ（MCP）はアカウントの他の Bot からも見える場合がある：使えるのは EN司令塔の鍵に許した intent・business だけ（VPS と Mac の 2 重）。他の Bot に使わせない時は、その Bot の Computer & Apps で MCP を外す
- EN司令塔の指示文に足す候補（Grok の画面で Human が貼る）：
  > E-NEXUS Task Intake（MCP）を使う時は business を必ず "e-nexus" にする。idempotency_key は「grok-<用途>-<日時>」のように毎回新しく作る。submit_task の後は 1〜5 分待って get_task_status で結果を読み、state と result をそのまま報告する（推測で補わない）。hermes.task は Human の承認が要り、承認されるまで実行されないことを伝える。秘密・パスワード・個人のメールアドレスを params に入れない。メールの送信・削除・予定の変更は依頼しない（受け付けない）。
  >
  > 質問と呼び方（params はこの形だけ。他の key を足さない）：
  > ・「承認待ちは？」→ intent "task.status"、params {"view":"awaiting_approval"}。items が自分の依頼、others_awaiting_approval は他の経路の承認待ちの件数。承認は Mac の端末で人が行うと伝える。
  > ・「最近失敗した仕事は？」→ intent "task.status"、params {"view":"failed"}。
  > ・「失敗の原因と対応は？」→ intent "task.status"、params {"view":"failed"}。result.next_steps の code ごとの who（requester＝params を直せば通る・human＝Mac の Human の判断か設定が要る・wait＝一時的）と retry（new_key＝新しい key で 1 回・later＝時間をおいて 1 回・no＝出し直さない）と text をそのまま伝える。1 件だけなら get_task_status の result.next。retry が no の依頼は出し直さない。
  > ・「さっきの仕事は終わった？」→ 直前の task_ref が分かれば get_task_status。分からなければ intent "task.status"、params {"view":"recent"}。
  > ・「終わった仕事の一覧」→ intent "task.status"、params {"view":"succeeded"}。
  > ・「Hermes は正常？」→ intent "status.query"、params {"detail":true}（result.hermes と result.sections.hermes を読む）。Hermes に出した依頼の結果は intent "task.status"、params {"view":"hermes"}。
  > ・「Mac の状況は？」「Mac mini は正常に動いている？」→ intent "status.query"、params {"detail":true}（result.overall と result.sections を読む）。
  > ・「Hermes の仕事は何件残っている？」→ intent "status.query"、params {"detail":true} の result.hermes（waiting＝実行待ち・running）と result.task_hub.awaiting_approval（承認待ち）。
  > ・「昨日失敗した作業はある？」→ intent "task.status"、params {"view":"failed"}。items の updated_at（UTC）を日本時間の昨日で絞って答える。
  > ・「実行した仕事の結果を報告して」→ intent "task.status"、params {"view":"hermes"}。新しい 5 件は items に summary（200 字まで）がある。全文は task_ref で get_task_status。
  > ・「失敗の原因と次にやることを Hermes に整理させて」→ intent "hermes.task"、params {"title":"運用の見直し","body":"<頼みたい観点>","kind":"ops_review"}。課金があり Mac で承認されるまで動かないと伝える。
  > state が "rejected" か "failed" で result.hint がある時は、hint の形に params を直し、新しい idempotency_key で 1 回だけ出し直す。

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
| Hermes の状態 | 「Hermes の業務はどうなってる？」「Hermes の仕事は何件残っている？」 | `status.query {detail:true}` の hermes・`task.status {view:"hermes"}` | 今使える |
| 実行した仕事の結果 | 「実行した仕事の結果を報告して」 | `task.status {view:"hermes"}`（新しい 5 件の要約の頭・2026-11-18）・全文は task_ref | 今使える（Mac の側。Hermes の実機の結果はまだ 0 件） |
| 失敗の原因・次の作業の整理 | 「失敗の原因と次にやることを Hermes に整理させて」 | `hermes.task {kind:"ops_review"}` | 毎回 Mac で承認（課金あり） |
| 承認待ちの一覧 | 「承認待ちは？」 | `task.status {view:"awaiting_approval"}` | 今使える（11-16 に EN司令塔からの往復を検収済み・§7。承認は Mac の端末） |
| 失敗した仕事 | 「最近失敗した仕事は？」 | `task.status {view:"failed"}` | 同上 |
| 失敗の原因と対応 | 「失敗の原因と対応は？」 | `task.status {view:"failed"}` の `next_steps`（code ごとの決まった文・2026-11-24・§8） | 今使える（Mac の側。Grok からの往復は未検収） |
| さっきの仕事 | 「さっきの仕事は終わった？」 | `get_task_status`（task_ref）・`task.status {}`（recent） | 同上 |
| 終わった仕事 | 「終わった仕事の一覧」 | `task.status {view:"succeeded"}` | 同上 |
| 朝のまとめ | 「朝のまとめを出して」 | `report.morning` | 今使える |
| メモ | 「現場A のメモ：図面は来週」 | `note.record {text, case_ref}` | 今使える |
| 現場資料の検索 | 「現場A の平面図を探して」 | `dropbox.search` | 承認の後（Dropbox の設定・許可フォルダ・公開） |
| 現場カルテの確認 | 「C-001 のカルテの注意事項は？」 | `karte.get {section:"safety"}`・`karte.report` | 承認の後 |
| 現場カルテへの追記 | 「C-001 の搬入経路に、西側から入れると追記して」 | `karte.append` | 承認の後 |
| 見積の AI タブの作成 | 「現場A の見積を見て、AI_案2 に新しい見積を作って」 | `estimate.ai.create`（毎回 Mac で承認） | 承認の後 |
| AI タブの修正 | 「AI_案2 の足場の数量を 300 にして」 | `estimate.ai.edit`（毎回 Mac で承認） | 承認の後 |
| 今週の予定 | 「今週の工程表は？」「明日の予定は？」 | `schedule.read {}`（今日から 7 日）・`{date}`・`{from,to}`（31 日まで。`next_from` が在れば続きを聞く） | 承認の後 |
| 工程表の予定 | 「工程表で現場A の予定は？」 | `schedule.read {query}`（今日以後。過去は `from`・`to` をつける） | 承認の後 |
| 工程表の臨時バックアップ | 「今の工程表をバックアップして」 | `schedule.backup`（完了は保存と検証の後だけ） | 承認の後 |
| バックアップの履歴 | 「工程表のバックアップの一覧」 | `schedule.backup.list` | 承認の後 |
| 昨日の工程表 | 「昨日の工程表を出して」 | `schedule.restore {at}`（別の file） | 承認の後 |
| ドコモメール | 「ドコモの新着は？」 | （読み取りの取得は実装済み・資格情報と取り込みの決定の後） | 承認の後 |

Human が「人間が作ったタブ 1 と 2 は触らないで」と言わなくても、AI が直せるのは AI が作った `AI_` のタブだけ（docs/dropbox-business.md §6）。

## 7. task.status の本番の失敗と直し（2026-11-16）

| 日時（JST） | EN司令塔の呼び方 | 結果 | 原因 |
|---|---|---|---|
| 11-15 22:58 | `task.status`・params `{}` | failed `params_task_ref_or_view` | handler が「task_ref か view のどちらか 1 つ」を必須にしていた。Bot は params の形を知らなかった |
| 11-15 23:19 | `task.status`・params `{"view":"pending"}` | rejected `params_invalid` | 台帳の view は `awaiting_approval`。Bot は普通の語（pending）で呼んだ |

接続（Grok → VPS → Mac）は 2 回とも通っている＝接続の障害ではない。**根本の原因は、Bot が params の形を知る手段が無かったこと**：MCP の道具の説明は intent ごとの params を持たず（VPS は params を解釈しない設計）、EN司令塔の指示文（§3）にも view の語が無く、断った時の返事は code だけだった。

直し（Mac の側は working tree から 5 分ごとの回が読むので、その場で本番に効く）：

1. params が空＝`recent`（自分の依頼の新しい順）
2. view の別名を受ける：`pending`・`approval`・`awaiting` → `awaiting_approval`、`failure(s)`・`error(s)` → `failed`、`success`・`done`・`completed` → `succeeded`、`all`・`latest` → `recent`（結果の `view` は正式な語）
3. `succeeded` の view を足した（終わった依頼の一覧）
4. 断った時は `result.hint` に正しい params の形を返す（台帳 `intents.json` の `usage`。status.query・task.status・report.morning・note.record・hermes.task）
5. VPS の受け口の道具の説明に「`list_capabilities` で自分の鍵の intent・business が分かる」「断られたら `result.hint` を読む」を足した（**VPS への反映は Human の 1 コマンド**＝`docs/vps-maintenance.md`。反映前でも 1〜4 は効く）
6. EN司令塔の指示文の候補（§3）に、質問と呼び方の対応を足した（**Grok の画面で Human が貼る**）

境は変えていない：返すのは同じ依頼元・同じ business の依頼だけ、他の依頼元の承認待ちは件数だけ、依頼の題名・本文は返さない。

検収：Mac の本番の store・本番の config で `{}`・`{"view":"pending"}`・`{"view":"failed"}`・`{"view":"hermes"}` が succeeded、`{"view":"approvals"}` が rejected＋hint（2026-11-16・source human-cli）。**EN司令塔からの往復（Grok → VPS → Mac → 結果）は検収済み**：2026-11-16 08:26Z に grok-commander（channel vps-intake）の task.status 4 件（`{}`・`view:"pending"`・`view:"failed"`・`view:"hermes"`）が Mac の store で succeeded（2026-11-18 に Claude Code が `task-hub list` と task の記録で確認）。EN司令塔の指示文（§3）を Grok の画面に貼ったかは未確認（ledger `grok-ask-first`）。

## 8. 失敗の「次にやること」（2026-11-24）

`task.status` の一覧に失敗（failed・rejected・expired・stopped・blocked）が含まれる時、結果に `next_steps` を付ける：code（無ければ state）ごとに `{ who, retry, text }` が 1 つ。1 件の `task_ref` で引いた失敗には `next` が付く。

- who：`requester`（依頼元が params を直せば通る）／`human`（Mac の Human の判断・承認・設定が要る）／`wait`（時間切れ・回線・混雑などの一時的な失敗）
- retry：`new_key`（新しい idempotency_key で 1 回）／`later`（時間をおいて 1 回）／`no`（出し直さない）
- 文は `scripts/lib/task-hub/next-step.mjs` の表の**決まった文だけ**。依頼の中身・Mac の log・他の依頼元の情報は混ざらない（外へ出す範囲は変えていない）。表に無い code は「Mac で確かめる・出し直さない」
- 自動の再実行はしない。Human の承認の境（`hermes.task` など）も変えていない

検収：合成の store の試験（`tests/task-hub-next-step-20261124.test.mjs`）と、Mac の本番の store で source human-cli の依頼（2026-11-24）。**EN司令塔からの往復は未検収**（Human が「失敗の原因と対応は？」と聞いて、結果の `next_steps` を確かめる）。§3 の指示文の候補に 1 行足した（Grok の画面で貼るのは Human）。
