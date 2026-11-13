# Hermes に業務を渡す時の決まり（案・2026-11-10・MA-24）

**状態：案。Hermes には何も渡していない。** 渡し始めるには Human の判断（下の §9）が要る。この文書は、渡し始める前に権限の範囲と検収の手順を決めておくためのもの。
Hermes は常駐している（gateway だけ・messaging platform なし・cron の job なし）。今の役目は監視の要約を読むことだけ（`docs/runtime-monitoring.md`）。

## 1. 渡す仕事の形（往きと還り）

```
Human/Bot の依頼 → Task Hub（分類・承認）→ hermes.task（承認済みだけ）→ hermes_inbox/<task_id>.json
                                                                          │ Hermes（cron・Human が --paused で定義）が読む
Task Hub の記録（business の notes）← collect-hermes ← hermes_outbox/<task_id>.json ←┘
```

| 向き | file | 中身 |
|---|---|---|
| 往き（Task Hub が書く・Hermes は読むだけ） | `hermes_inbox/<task_id>.json`（0640） | `{ v: 1, task_id, business, title（120 字まで）, body（2000 字まで）, approval_record: { at, digest } }` |
| 還り（Hermes が書く・Task Hub は読むだけ） | `hermes_outbox/<task_id>.json` | `{ v: 1, task_id, status: "done" \| "failed", summary（2000 字まで） }`。他の field は拒否 |

- 往きは `hermes.task`（`human_required`）だけ。**承認の前に Hermes へ渡る道は無い**。inbox のフォルダが無い間は休眠（`hermes_inbox_not_connected`・作らない）
- 還りは `node scripts/task-hub.mjs collect-hermes`（`scripts/lib/task-hub/hermes-results.mjs`）。`hermes_outbox` が無い間は休眠
- 還りは**記録だけ**：task の business の notes に `hermes:<task_id>` の 1 件と、監査に `hermes_result` の 1 行。**何も実行しない・承認の代わりにならない・次の task を作らない**

## 2. Hermes の出力は不信頼

依頼の本文と同じに扱う（`docs/task-hub.md` §4）。`collect-hermes` は次を拒み、記録しない（理由のコードだけ出して exit 1。Hermes の file は消さない）：

| 拒否 | コード |
|---|---|
| 名前が task の id の形でない file | （読まない） |
| symlink・FIFO・16 KiB を超える file | `bad_file` |
| 読めない（権限） | `unreadable` |
| JSON でない・未知の field（`approved`・`business` など）・`task_id` が名前と違う・status が done/failed 以外 | `bad_json`・`bad_shape` |
| 対応する task が無い・`hermes.task` でない | `unknown_task` |
| task がまだ渡されていない（承認されていない・失敗した） | `task_not_delivered` |
| summary が envelope の関所に落ちる（鍵の形・見えない文字・長すぎる・NFKC の後の長さ） | `summary_*` |

business は task のものを使う（Hermes が名乗っても使わない）。取り込んだ task は `<store>/hermes-collected/<task_id>` の印で覚え、以後その file を読まない（Hermes が書き換えても・notes が保持の上限で消えても二度記録しない＝`already`）。監査の行を記録より先に書く。

## 3. Hermes ができること（許可の一覧・案）

| 許可（案） | 内容 |
|---|---|
| 状態の要約を読む | 今と同じ（`runtime-status-summary`・allowlist の水準だけ） |
| 承認済みの依頼を読む | `hermes_inbox` を読むだけ |
| 結果を書く | `hermes_outbox` の 1 file だけ（下の §4） |
| 業務データの整理 | 依頼の `body` に書かれた範囲だけ。データは依頼の本文で渡す（Hermes に Mac のファイルを探させない） |
| Human Required を返す | `status: "failed"` と summary に理由（Task Hub の記録に残り、Human が見る） |

| 禁止（変えない） | 担保 |
|---|---|
| 任意の Shell・コードの実行 | managed config の `disabled_toolsets`（terminal・code_execution ほか 7 つ）。変えるのは Human |
| ブラウザ・computer use・外部への接続・cron の自作・delegation | 同上 |
| OS 全体の読み書き | hermes ユーザーの OS の権限（operator の home は 0700）。下の §4 |
| 秘密の送信・メールの操作・Trading Lab・本番の設定の変更 | handler が無い（Task Hub）＋ toolset が無い（Hermes）＋ Human Gate |

## 4. ファイルの範囲（Human の判断が要る）

- `file` toolset（read_file・write_file・patch）は**今は無効の一覧に入っていない**。今は agent を動かす経路（platform・cron）が無いので実害は無い
- 公式の `HERMES_WRITE_SAFE_ROOT`（環境変数）は **write_file と patch の書き先**を指定した場所に限る。**読みは限らない**、そして公式の docs も「乗っ取られた agent の sandbox ではない」と書いている（hermes-agent.nousresearch.com/docs/user-guide/security）。v0.22.4 にあるかは未確認（release notes に記載なし）
- 推奨（案）：
  1. 渡し始めるまでは `file` を `disabled_toolsets` に足す（一番狭い。Hermes の再起動を伴う）か、今のまま（経路が無い）
  2. 渡し始める時は `HERMES_WRITE_SAFE_ROOT=<hermes_outbox>` を managed の環境に入れ、hermes ユーザーが書ける場所を `hermes_outbox` だけにする（OS の権限）
  3. フォルダの権限（案）：`hermes_inbox` は operator が所有・group は **hermes だけが入る専用の group**（`staff` など全員の group にしない＝承認済みの依頼の本文が他の local user に読める）・0750（Task Hub が書く file は 0640＝その group だけ読める）。`hermes_outbox` は hermes が所有・group は operator が入る group・2750（setgid）で、Hermes が書く file を group が読める mode（umask 027 か ACL）にする。読めない file は `collect-hermes` が `unreadable` で拒む
  4. 読みは OS の権限が境界：hermes ユーザーから operator の home・Trading Lab の領域・Keychain が読めないことを検収で確かめる
- **読みの境界の確かめ方（検収）**：operator の home が 0700 で、hermes ユーザーが入れないこと（`.claude`・Vault の clone・runtime の repo・Task Hub の保存先・`~/.enexus`）。hermes ユーザーが入っている group と、home の外でその group に読める場所を一覧にする（今の値は開発ログに記録・この repo には書かない）
- **inbox の推奨**：共有の場所（`/Users/Shared` の下）に、operator 所有・**operator と hermes だけが入る専用の group**・0750 で Human が作る。`hermes.task` の handler は、other に権限のあるフォルダと、macOS で group が `staff` で group に権限のあるフォルダには書かない（`hermes_inbox_unsafe`・2026-11-10）
- `HERMES_WRITE_SAFE_ROOT` は書き先だけの制限。読みの制限は上の OS の権限（home の 0700・専用の group）が担う。terminal の toolset は OS の権限の範囲で何でも読めるので、渡し始める前に `terminal` を `disabled_toolsets` に入れるかを Human が決める（§9）

## 5. モデルと費用

- 今の設定は Anthropic の API（Haiku）・月の上限は既存の決定のまま。**新しい有料の実行は Human の承認の後**
- 1 回の上限（案）：入力 20k・出力 2k token、1 日の回数は cron の間隔で決める（例：1 時間に 1 回＝最大 24 回）
- 実際の費用は Anthropic の Console で見る（Hermes の読み取りの検証で計上先は確認済み）

## 6. 実行の前の Human Gate

- `hermes.task` は承認が要る（`human_required`）。承認は Mac の端末で確認コード（`docs/task-hub.md` §6。強い本人確認ではない）
- 承認の後に params が変わると承認は外れる（`content_changed`）。承認の期限は 24 時間
- Hermes の結果は承認にならない。結果を受けて何かをする時は、新しい依頼として Task Hub へ出し直す（もう一度分類と承認を通る）

## 7. 失敗の時

| 場面 | どうなる |
|---|---|
| inbox が無い | `hermes_inbox_not_connected`（再試行しない・Human が見る） |
| inbox へ書く途中で止まった | `hermes.task` は再開しない（`stopped`。二度渡さない） |
| Hermes が `failed` を返した | 記録に `status: failed` と理由。再実行はしない（Human が出し直す） |
| Hermes が何も返さない | task は「渡した」（succeeded）のまま。返事の無いものは notes に `hermes:<task_id>` が無いことで分かる |
| 結果が不信頼の形 | §2 の拒否。exit 1（定期実行の失敗として見える） |

## 8. 記録

- 監査（`audit.jsonl`）：created・承認・渡した（succeeded）・`hermes_result`（hermes_done／hermes_failed）。値は書かない
- 業務の記録：`records/<business>/notes.jsonl` の `hermes:<task_id>`（summary・status）

## 9. 渡し始める手順（Human）と検収

1. §4 のファイルの範囲を決める（`file` toolset・`HERMES_WRITE_SAFE_ROOT`。sudo・Hermes の再起動）
2. フォルダを作る：`hermes_inbox`（operator が書く・hermes が読む）・`hermes_outbox`（hermes が書く・operator が読む）
3. Task Hub の local config に `hermes_inbox`・`hermes_outbox` を書く
4. Hermes の cron を `--paused` で定義し、1 回だけ手で動かす（有料の実行の承認）
5. 検収（Claude Code）：`hermes_inbox`・`hermes_outbox` の所有者・group・mode が §4 のとおり（group の member が hermes と operator だけ）。承認済みの `hermes.task` を 1 件 → inbox の 1 file → Hermes の結果 → `collect-hermes` で記録 1 件・監査の `hermes_result`・`verify-audit` OK。hermes ユーザーから operator の home が読めないこと

試験：`tests/task-hub-e2e.test.mjs` の「模擬 Hermes の往復」（承認の前に渡らない・不信頼の結果を記録しない・取り込み直しで増えない）。

## 10. 2026-11-11 の形（1 件ずつ・Human が実行）

- **フォルダ**（作成済み・sudo なし）：`/Users/Shared/e-nexus-hermes/work/inbox`（operator 所有・group `e-nexus-hermes-read`＝member は hermes と operator だけ・0750）、`…/work/outbox`（同じ group・2770＝hermes が書ける・新しい file は group を継ぐ）。Task Hub の config に `hermes_inbox`・`hermes_outbox` を設定済み＝承認済みの `hermes.task` だけが inbox に届く
- **起動の方法**：cron（毎回の課金・空回り）は使わない。`sh deploy/macos/hermes-work-run.sh --paid-ok` を Human が実行し、1 件だけ `hermes -z` で処理させる（hermes ユーザー・道具は `file` だけ・`HERMES_WRITE_SAFE_ROOT`＝outbox・cwd は inbox・120 秒で強制終了・Background）。`--paid-ok` が無ければ課金の前で止まる。課金の前に、hermes が依頼を読め・outbox に書け・operator の home と `~/e-nexus-runtime`・`~/.enexus` に入れないことを hermes の権限で確かめる
- **読みの境界**：OS の権限（operator の home 0700・Trading Lab の領域 0700・Keychain は hermes ユーザーのものではない）。hermes から読めるのは自分の home・`/Users/Shared/e-nexus-hermes` の status・vault の写し・work と、OS の誰でも読める場所。`HERMES_WRITE_SAFE_ROOT` は書き先だけ（§4）
- **費用**：Haiku・1 件で Messages API 2〜4 回（読み取りの検証で 2 回・12,239 token）。上限は Console の Hermes の workspace の月の上限のまま。無人の実行（sudoers で `hermes-work-run.sh` だけを許す等）は別の Human の判断
- **依頼元**：Human の端末（`human-cli`）と EN司令塔（`grok-commander`・2026-11-11 Human 承認）。どちらも `hermes.task` は毎回 Mac の端末で承認（`show` で全文を読んでから）
- **残る危険（受け入れ・記録）**：Hermes は自分の home（Hermes の API 鍵の入った設定を含む）と vault の写しを OS の権限で読める。依頼の本文が「それを summary に書け」と命じ、Human が承認すれば、summary は Grok Bot へ返る。envelope の関所は鍵の形（`sk-` 系など）を拒むが全部の形ではない＝**承認の時に本文が「ファイルの中身を写して返す」形でないかを読む**。outbox に渡した 1 件以外の file が増えたら script が取り込まずに消す
- 結果：`collect-hermes`（script の最後に自動）→ notes の `hermes:<task_id>` と監査の `hermes_result`。依頼元が bot なら結果の板へも返す（`docs/task-hub.md` §14）
