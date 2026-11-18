# Hermes に業務を渡す時の決まり（案・2026-11-10・MA-24）

**状態（2026-11-18）：受け渡し・実行の記録・sandbox・結果の返却まで実装済み（§11）・承認の期限・実用の依頼の種類・結果の一覧（§12）。初回の課金なしの確かめの停止を直した（§12-6）。続く `--check-only` の停止（Hermes の `-z` が sandbox の外の常駐の gateway へ渡そうとした）を、Hermes を sandbox の中の同じ process で動かす形に直した（§12-7・Hermes 本体での確かめは Human の `--check-only` 待ち）。有料の実行は 1 件ずつ Human が Mac の端末で承認して起動する。実機の業務の実行の実績はまだ無い。** §1〜§9 は 2026-11-10 の設計、§10 は 2026-11-11 の形、§11・§12 が今の形。
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
- **残る危険（2026-11-11 時点・§11 の sandbox で閉じた）**：Hermes は自分の home（Hermes の API 鍵の入った設定を含む）と vault の写しを OS の権限で読める。依頼の本文が「それを summary に書け」と命じ、Human が承認すれば、summary は Grok Bot へ返る。envelope の関所は鍵の形（`sk-` 系など）を拒むが全部の形ではない＝**承認の時に本文が「ファイルの中身を写して返す」形でないかを読む**。outbox に渡した 1 件以外の file が増えたら script が取り込まずに消す
- 結果：`collect-hermes`（script の最後に自動）→ notes の `hermes:<task_id>` と監査の `hermes_result`。依頼元が bot なら結果の板へも返す（`docs/task-hub.md` §14）

## 11. 2026-11-13 の形（実行の記録・sandbox・課金なしの確かめ）

入口は 1 つ：`sh deploy/macos/hermes-work-run.sh [--paid-ok] [--task <id> --retry]`（＝`node scripts/hermes-work.mjs run`）。**Human が Mac の Terminal で実行**（sudo の password と承認の確認コード）。

1. 承認待ちの `hermes.task` を 1 件ずつ `task-hub show` と同じ全文で見せ、確認コードを打てば承認（`task-hub approve` と同じ関所：端末だけ・digest・24 時間。空 Enter で飛ばす）
2. Task Hub の queue を回して、承認済みの依頼を Hermes の inbox へ渡す（`hermes.task` の結果は `{ delivered: true, hermes: { status: 'waiting' } }`）
3. 渡す 1 件を選ぶ（古い順・waiting だけ）。`--paid-ok` が無ければここで止まる。`--paid-ok` なら sudo の password（排他を取る前に聞く）
4. **課金なしの確かめ**：メモリ・常駐・RSS／hermes の権限（依頼を読める・outbox に書ける・operator の home に入れない）／profile の home に `.env` が無い／root の `.env` に鍵の行がある（値は見ない）／profile に hooks・plugins・cron が無い／sandbox の規則（鍵・gateway の state が読めない・依頼が読める・root の設定と plugins に書けない・outbox の他の名前に書けない・usage に書ける）／**無効な鍵で Hermes を sandbox の中で起動**（Anthropic が 401 を返すところまで＝起動・依存・state の場所が sandbox で壊れないこと）。どれかが違えば始めない（`preflight_<code>`。起動の確かめで止まった時は、その時刻の sandbox の拒否の行〈path だけ〉を store の `hermes-work-logs/` に残す＝Human にもう一度実行してもらわずに原因を読む）
5. 実行の記録を running にし（監査 `hermes_started`・依頼元へ `hermes.status: running`）、`hermes -z` を 1 回（120 秒・`-t file`）
6. 渡した 1 件以外に増えた・書き換えられた outbox の file は取り込まずに store の `hermes-quarantine/` へ移す（消さない・symlink・FIFO は写さずに外す）→ 結果があれば `collect-hermes` の関所 → done／failed、無ければ timeout／no_result、関所に落ちれば result_rejected → 依頼元へ返す（`task-intake-sync push`。失敗しても 5 分の回が返す）

### 実行の記録（`<store>/hermes-jobs/<task_id>.json`・`scripts/lib/task-hub/hermes-jobs.mjs`）

| 状態 | 意味 | 次 |
|---|---|---|
| （記録なし）waiting | 承認済みで inbox へ渡した・未実行 | `hermes-work-run.sh --paid-ok` |
| running | 実行中（名前つきの排他 `hermes-work` を持つ間だけ） | — |
| done／failed | 結果を記録した（failed は Hermes 自身の「できない」） | 終わり（やり直しは新しい依頼） |
| timeout・no_result・result_rejected | 時間切れ・結果なし・結果を記録しなかった | Human が `--task <id> --retry --paid-ok`（有料・最大 3 回） |
| interrupted | running のまま持ち主が居なくなった（強制終了・再起動）。定期の回の `collect-hermes` が見つけて付け替え、依頼元へ返す。始めてから 4 分の間と、run の印（prompt の `run <token>`）を持つ hermes の process が見える間は付け替えない（まだ動いている実行を二重にしない） | 同上 |
| dismissed | Human が実行せずに閉じた（`node scripts/hermes-work.mjs dismiss <id> --confirm <12 桁>`・端末だけ） | 終わり |

- **二重の実行・課金をしない**：同時に 1 つ（排他）。自動で選ぶのは waiting だけ。結果の file が在る依頼は実行しない（`result_waiting`＝取り込みを待つ）。記録しなかった結果（result_rejected）の file は隔離するので、`--retry` でやり直せる
- 監査：`hermes_started`・`hermes_timeout`・`hermes_no_result`・`hermes_result_rejected`・`hermes_interrupted`・`hermes_result`・`hermes_job_closed`（値は書かない）。usage は数だけ記録に（token・回数・model 名）
- 依頼元（Grok）は `get_task_status` の `result.hermes.status`（waiting → running → done／failed／timeout…）と、done／failed の時は `summary`。`task.status`（task_ref）でも同じ
- `node scripts/hermes-work.mjs status`：記録の一覧（読むだけ）。host-health の `hermes_jobs` が stuck・承認済みで 24 時間未実行・timeout 等を warn で 1 通（`docs/task-hub.md` §15）

### sandbox（`scripts/lib/hermes-sandbox.mjs`・OS の権限で読みを絞る）

2026-11-11 の残る危険（Hermes が自分の home の鍵を読める）は、Hermes 自身の file の守り（v0.22.4 の `agent/file_safety.py`：`.env`・auth の file を拒む）が code の中で「security boundary ではない」と書かれているので、OS の側で閉じる。

- **home**：業務は Hermes の profile の home（`HERMES_HOME=~/.hermes/profiles/work`）で動かす。profile は root の依存の環境をそのまま使い（同期・download をしない＝`HERMES_DISABLE_LAZY_INSTALLS=1` も付ける）、`.env` は自分の home の物だけを読む。profile に `.env` は置かない（在れば始めない）
- **鍵**：sandbox の外の loader（perl・hermes の権限）が root の `.env` の `ANTHROPIC_API_KEY` の行だけを読み、環境変数で渡す（画面・引数に出さない）。**常駐の gateway の `.env` は変えない**
- **読める（allowlist・2026-11-13 独立監査 F1・F2 の後）**：Hermes の code（hermes-agent）・python（tools）・依存（installs）・業務の profile の home・~/.local/bin・この依頼の 1 file・状態の要約の 1 file・usage の 1 file・この依頼の結果の 1 file
- **読めない**：全ユーザーの home（operator・Trading Lab）・`/Volumes`・`/private/tmp`・Keychain・`/private/var/db`、root の state.db・sessions・memories・logs・backups・cron・config・他の profile、outbox の他の結果・inbox の他の依頼（一覧も）、どこでも `.env` 系・auth の file
- **書ける**：業務の profile の home（state・sessions・logs・cache）・依存の lock（`installs/<key>/.install.lock`）と lease（`…/.leases/`）・usage の 1 file・この依頼の結果の 1 file・OS の一時。**書けない**：常駐の gateway の root（plugins・hooks・cron・skills・config・SOUL・code・python・依存の中身）、profile の config.yaml・hooks・plugins・cron・skills・memories・cwd・SOUL.md／AGENTS.md・`.env`（`-z` は hook を自動で受けるので、植えられると次の実行で動く＝書かせない）
- **通信**：TCP 443 だけ（名前解決は mDNSResponder）。**起動できない**：security・osascript・curl・ssh・scp・rsync・open・launchctl・pbcopy・screencapture・sudo
- 確かめ：`tests/hermes-sandbox.test.mjs`（Mac の sandbox-exec で模擬の /Users の上の読み 25・書き 33・起動 2）・2026-11-13 に 443 だけ通ること（api.anthropic.com は届き、80 番は EPERM）を手で確認。Hermes 本体での起動は手順 4 の無効な鍵の確かめ（課金なし）
- 残る範囲：profile の state.db・sessions（前の業務の会話）は読める。業務の依頼は毎回 Human が全文を読んで承認する。sandbox-exec は Apple が非推奨としている（動いている間は使い、使えなくなれば手順 4 で止まる）

### 戻す

`deploy/macos/hermes-work-run.sh` を 2026-11-11 の版（git の `87eeeb1`）に戻せば前の形（sandbox なし）。profile の home（`~/.hermes/profiles/work`）は hermes の権限で消してよい（業務の会話だけ）。記録 `hermes-jobs/` は消しても task は変わらない。

## 12. 2026-11-18 の仕上げ（承認の期限・実用の依頼の種類・結果の返し方）

### 12-1. 承認から 24 時間を過ぎた依頼（`approval_stale`）

承認の期限（24 時間）は「inbox へ渡す」までを縛り、渡した後の有料の実行までは縛っていなかった（`task-hub approve` の数日後に `hermes-work-run.sh --paid-ok` を打つと、古い依頼が全文を見ないまま実行された）。

- `run --paid-ok` は、選んだ 1 件の承認の `expires_at` が過ぎていれば、**sudo の前**に params の全文と確認コードを見せ、打ち直した時だけ進む（端末だけ・空 Enter・違うコードは実行しない）。監査に `hermes_reconfirmed`（値なし）
- 見せる前に、**Hermes が実際に読む inbox の file** が承認した title・body・kind と digest に一致するかを確かめる（違えば聞かずに止める）。`ops_review` は状況を作った時刻も見せる（渡した時の状況＝今の状況ではない）
- 端末でない・確かめていない 1 件は `approval_stale` で止まる（**sudo も聞かない**・課金なしの確かめも実行もしない・記録は waiting のまま）。やめる時は `dismiss`。依頼元への知らせは出さない（host-health の `hermes_jobs` が 24 時間の未実行で warn）
- 確かめるのは CLI が排他の外で選んだ 1 件。排他の中で選び直した 1 件が違えば、それは確かめていない＝止まる
- 承認の記録が無い・壊れている時も「過ぎた」側（確かめ直しを求める）

### 12-2. 実用の依頼の種類（`hermes.task` の `kind`）

| 頼みたいこと | 使うもの | Hermes | 課金 | 承認 |
|---|---|---|---|---|
| A. Mac Runtime の稼働状態 | `status.query {detail:true}` | 使わない | なし | 不要 |
| B. Task Hub の依頼の状態の一覧 | `task.status {view}` | 使わない | なし | 不要 |
| C. 失敗の原因の分類と報告 | `hermes.task {kind:"ops_review"}` | 使う | あり | 毎回 |
| D. 実行した結果の要約 | `task.status {view:"hermes"}`（新しい 5 件の要約の頭・12-3）、まとめ直すなら `ops_review` | 一覧は使わない | 一覧はなし | 一覧は不要 |
| E. 未完了と Human 待ちの整理 | 件数は `status.query {detail:true}`・一覧は `task.status {view:"awaiting_approval"}`、整理は `ops_review` | 整理だけ | 整理だけ | 整理だけ |
| F. 安全な次の作業の候補 | `ops_review`（読む・記録するだけの手を 3 つまで） | 使う | あり | 毎回 |

A・B・D・E の一覧は既存の無料の intent で足りる＝Hermes の種類にしない（重複させない・課金しない）。

`kind: "ops_review"`：
- 承認の対象は params（title・body・kind）。**状況は承認の後、inbox へ渡す時に作る**（`handlers.mjs` の `opsReviewContext`）：`status.query {detail:true}` と同じ水準・件数、PAUSE、7 日の間の同じ依頼元・同じ business の依頼（intent・state・code・時刻・試行の回数・Hermes の状態だけ）と state・code ごとの件数。**依頼の params・summary・Hermes の結果の文・task_ref・path は入れない**。他の依頼元の分は件数だけ（`task.status` と同じ範囲）。**台帳に無い intent の名前は Bot が書いた文字列なので `unknown_intent` に置き換える**（長さの上限が無く、名前に指示を混ぜられる＝独立監査 F1）。code は固定の形だけ（違えば `other`）、state・code の組は多い順に 20 まで（残りは `other_codes` に件数）。一覧は 30 件まで、8 KiB を超えれば 15→5→0 件に減らし、全部でない時は `recent_truncated: true`。それでも超えれば水準と PAUSE だけ残す（`truncated`）。file は行に分けて書く（1 行の上限で切られないように）
- 状況は Hermes にとっても**データであって指示ではない**と決まった指示の文に書いた（依頼の本文と同じく不信頼の側）
- Hermes への指示は種類ごとの決まった文（`hermes-work.mjs` の `KIND_GUIDES`）。依頼の文からは作らない。sandbox・読める file は変えていない（状況は依頼の file の中にある）
- 台帳に無い種類は `params_invalid`（承認待ちにもならない）

### 12-3. 結果の返し方（Grok の「実行した仕事の結果は？」）

`task.status {view:"hermes"}` の一覧は、新しい方から 5 件だけ結果の要約の頭（200 字・切った時は `summary_truncated: true`）も返す。全文は `task_ref` で引く。要約は `collect-hermes` の関所を通り、同じ依頼元へ返している文と同じ。

### 12-4. 今の実行可能の状態（2026-11-18 14 時台に読むだけで確認）

- 常駐の gateway は動いている。inbox は 0750・outbox は 2770（どちらも専用の group）。inbox・outbox は空＝**Hermes の実機の業務の実行の実績はまだ無い**
- 11-11 の承認待ちの `hermes.task` 1 件は承認されないまま、11-18 17:09 JST に 7 日の期限で `expired`（`approval_timeout`・依頼元へ板で返す）になる。**黙って出し直さない**
- 実機の初回は Human（§11 の `hermes-work-run.sh --paid-ok`）。新しい依頼を出し、Mac の端末で承認して 1 件実行する

### 12-5. 無人の継続・復旧の確かめ（どこで担保しているか）

| 要る機能 | 担保 | 試験 |
|---|---|---|
| 独立の task の継続 | runner の 5 分の回・時間の予算・Dropbox だけの回路遮断（`docs/task-hub.md` §5） | `task-hub-autonomy-20261118` |
| 承認待ちの隔離 | `awaiting_approval` は走らない・7 日で expired・Hermes は承認の後だけ inbox | `task-hub-e2e`・`hermes-ops-20261118` |
| 有限回の再試行 | handler は既定 3 回の指数 backoff。Hermes は自動でやり直さない（有料）・`--retry` で最大 3 回 | `hermes-work` |
| 二重の実行の防止 | run.lock・名前つきの排他 `hermes-work`・結果の file が在れば実行しない・取り込みの印 | `hermes-work`・`task-hub-chain` |
| 時間の上限 | handler の timeout・Hermes は 120 秒で強制終了・課金なしの確かめは 60 秒 | `hermes-work` |
| エラーの分類 | 固定の code（監査・板・host-health の `hermes_jobs`） | 各 test |
| 結果の永続化 | `hermes-jobs/`・notes・監査の鎖 | `hermes-work` |
| 中断の後の整合 | lease の切れた running・`interrupted`（4 分の猶予と process の印） | `hermes-work` |
| host-health | `task_hub_approval`・`task_hub_queue`・`hermes_jobs`（§11） | `task-hub-watch` |
| 安全な停止と復旧 | `PAUSE`・`connect-task-hub.sh --remove`・`dismiss` | `task-hub` |

新しい定期の job・常駐・無制限の自律ループは足していない。

独立監査（2026-11-18・1 名）：high 0・medium 1（F1 上記）・low 7（code の数の上限・切り詰めの印・確かめ直しで inbox の file を照らす・断った時に sudo を聞かない・状況の読みの失敗の code・行に分けて書く・壊れた記録 1 つで失敗にしない）。全部直して試験を足した（`tests/hermes-ops-20261118.test.mjs`）。残り：Hermes の `read_file` が長い file をどこで切るかは未確認（v0.22.4 の source で確かめていない。実機の初回の結果で見る）

### 12-6. 初回の課金なしの確かめで止まった（2026-11-18 16:36 JST・`preflight_probe_sandbox_breaks_hermes`）

- **起きたこと**：Human の初回の `--paid-ok` の実行（`t-20261118073100-b6888126`）が、無効な鍵で Hermes を sandbox の中で起動する段で止まった。**有料の実行はしていない**（job を始める前・試行 0・記録は waiting のまま）
- **原因**（store の `hermes-work-logs/<task>-probe.txt`）：Hermes v0.22.4 は起動の度に HERMES_HOME の下へ `cron`・`sessions`・`logs`・`logs/curator`・`memories`・`pairing`・`hooks`・`image_cache`・`audio_cache`・`skills` を作り、`SOUL.md` が無ければ既定の文を書く（commit 4d04303 の `hermes_cli/config.py` の `_HERMES_HOME_SUBDIRS`・`config_home.initialize_home`・`_ensure_default_soul_md`）。sandbox は `cron`・`hooks`・`memories`・`skills`・`SOUL.md` への書きを**わざと**拒む（§11：植えられると次の実行で動く・読まれる）ので、`profiles/work/cron` の mkdir が EPERM になり `HomeInitializationError` で止まった。11-13 の設計は「profile の中の hook 等は作れない＝無いはず」とし、前の確かめも「在れば止める」だった＝Hermes の起動の段と両立しなかった。sandbox の規則の試験は Hermes 本体を動かさないので見つけられなかった
- **直し**（sandbox の規則は変えない）：課金なしの確かめの中、sandbox の外（hermes の権限）で `prepareWorkHome` が空の `cron`・`hooks`・`memories`・`skills` と決まった文の `SOUL.md`（0600・Hermes の旧い雛形と違う文＝Hermes は書き換えない）を先に置く。毎回「空・link でない・SOUL.md の文が同じ」を確かめ、違えば `work_home_has_<dir>`・`work_home_soul_changed`・`work_home_link` で止める。`plugins`・`.env` は前と同じく在れば止める。Hermes は在るフォルダの mkdir の失敗（Python の `mkdir(exist_ok=True)` は在れば EPERM でも通す）と chmod の失敗を無視する
- **残りの警告**：`install out of sync (venv: could not enumerate profiles)` は sandbox が profiles の一覧を読ませないための警告（`pm/plugins_state.dependency_homes`）で、止まる原因ではない。一覧を許すと他の profile の名前が見えるので許さない
- **`--check-only`**（新）：`sh deploy/macos/hermes-work-run.sh --check-only` は課金なしの確かめ（sudo・sandbox の規則・無効な鍵での起動）までで止める。依頼を実行しない・試行に数えない・承認の確かめ直しも聞かない。`--paid-ok` と一緒には使えない
- **試験**：`tests/hermes-home-init-20261118.test.mjs`（4 件）。本番と同じ sandbox の規則の中で、Hermes の起動の初めの段を同じ手順に写した Python を動かし、整える前は `profiles/work/cron` の EPERM で止まる（本番の log と同じ）・整えた後は通る・中へは書けないままを確かめる。sandbox で書けないフォルダの一覧は規則から導いて `WORK_LOCKED_DIRS` と照らす
- **未確認**：Hermes 本体を実機の sandbox で起動して 401 まで届くか（sudo の password が要る＝Human）。起動の段より後に別の書けない所へ書くかは、`--check-only` の結果で見る
- **独立監査**（2026-11-18・1 名）：high 0・medium 2・low 3。全部直して試験を足した。M1：中が空かを `ls -A` で見ていたので、名前に改行の在るフォルダ（`skills/<改行>/SKILL.md`）が空に見えた → `find -mindepth 1 -print -quit`。M2：一覧を読めない mode（0100）のフォルダは空に見え、決まった名前の file（MEMORY.md 等）は Hermes に読まれる → chmod 700 してから mode・持ち主・中身を確かめ、一覧の失敗は止める。L3：確かめから実行までの間 → 起動の確かめの後（実行の直前）にもう一度。L4：`cwd` の中身（AGENTS.md 等が読まれる）と profile の `config.yaml` は前から見ていなかった → 在れば `work_home_has_cwd`・`work_home_has_config` で止める。`check_ok` で承認の期限切れも知らせる。残り（受け入れ）：`.hermes`・`profiles` が link の時は sandbox が本当の path で拒む＝止まる側。起動の段より後の書き（同梱の skill の同期・設定の移し替え・cron の lock）は source の写しからは決められない＝`--check-only` で見る

### 12-7. `--check-only` が `preflight_probe_no_auth_error` で止まった（2026-11-18 17:52 JST）

- **起きたこと**：§12-6 の直しの後の Human の `--check-only`（`t-20261118073100-b6888126`）が、無効な鍵で Hermes を起動する段で止まった。記録（store の `hermes-work-logs/<task>-probe.txt`）は exit 1・stderr `Error: Gateway inaccessible: authorization`。**有料の実行はしていない**（`--check-only`＝job を始めない・試行 0・waiting のまま）
- **原因**：これは Anthropic の 401 ではなく、Hermes の手元の gateway の拒否。v0.22.4 の `hermes -z` は gateway の client だけ（4d04303 の `hermes_cli/main.py` の `_run_oneshot_from_args` → `gateway_chat.launch_from_args` → `gateway_client.connect_gateway` → `gateway_runtime.ensure_gateway_runtime`）。会話の処理は gateway の owner が行い、named profile（`profiles/work`）の owner は root の multiplexer＝**常駐の gateway（sandbox の外・root の本物の鍵と設定）**（`gateway_runtime_multiplex.implied_host_root`）。sandbox は root の config と socket を拒むので、`PermissionError` が `gateway_runtime._refused` の `inaccessible: authorization` になった。止まったのは**安全の側**：つながっていれば、業務は sandbox の外で本物の鍵で動き、無料の確かめも課金されうる。11-13 の設計（と 11-07 の読む確かめ）は `-z` が自分の process で会話すると見ていた。確かめの判定は「401 の文が無い」としか見ず、gateway の止まりを名指せなかった
- **直し**（sandbox の規則は変えない・gateway へはつながせない）：Hermes の in-process の `-z` の本体（`hermes_cli.main._run_and_exit_oneshot` → `hermes_cli.oneshot.run_oneshot`。上流の `tests/hermes_cli/test_oneshot_*.py` が試験している）を、sandbox の中のこの process で動かす。起動は Hermes の launcher が出す runtime command（`hermes --print-runtime-command`＝`hermes_cli/_launchers.runtime_command`：store の python・`-I`・bootstrap）を sandbox の中で読み、最後の entry（`runpy.run_module('hermes_cli.main')`）だけを「gateway の transport を in-process に差し替えてから `main()`」に替える（`lib/hermes-sandbox.mjs` の `inProcessCommand`・`INPROC_ENTRY`）。引数の解釈・home の初期化・設定の読みは Hermes の main のまま。resume は使わせない。形が違えば `hermes_launcher_unexpected` で止める（python は Hermes の root の `hermes-agent`・`tools`・`installs` の下の `python3` で、名前の頭が `.` の段を含まない＝sandbox の中で書ける `installs` の `.leases`・`.install.lock` と profile の home の python は使わない。bootstrap は v0.22.4 の `runtime_command` の文と全文で同じこと。`_run_and_exit_oneshot` の引数が v0.22.4 と違えば起動しない＝Hermes を上げた時は `probe_inproc_unexpected` で止まる）。有料の実行も同じ command だけを使う（課金なしの確かめを全部通った時だけ決まる）
- **判定**（`classifyProbe`）：gateway の止まり（`Gateway inaccessible|absent|starting|…`・`no local fallback`）を先に見て `probe_gateway_transport` で止める＝gateway の「authorization」を鍵の 401 と読まない。401 は Hermes の出力（in-process の 401 は stdout の「rejected your API key」）と usage の file の `failure`・`turn_exit_reason` だけで見る（`\b401\b`＝session_id・token の数の中の数字を拾わない）
- **試験**：`tests/hermes-inproc-20261118.test.mjs`（8 件）。本番と同じ sandbox の規則の中で、launcher の runtime command の写しと `hermes_cli.main` の形の偽物を動かし、そのままなら gateway へ渡して止まる（本番と同じ判定）・`inProcessCommand` なら同じ process で `-z` を受ける（prompt・`-t file`・usage の file・HERMES_HOME＝業務の profile・resume なし）を確かめる。sandbox の通信の規則（TCP 443 と名前解決だけ）が変わっていないことも確かめる
- **未確認**：Hermes 本体の in-process の起動が sandbox の中で 401 まで届くか（sudo の password が要る＝Human の `--check-only`）。`hermes_bootstrap` が依存の版の違いで子の process に起動し直す時は差し替えが外れ、gateway へ渡そうとして `probe_gateway_transport` で止まる（止まる側）
- **独立監査**（2026-11-18 夜・1 名）：原因の見立て（gateway の client・multiplexer・`_refused`）と、in-process の道から本物の鍵・設定・常駐の gateway へ戻る道が無いこと（管理の設定の `fallback_providers: []`・auth と .env の読みの拒否・通信は 443 だけ・bootstrap の起動し直しも `-c` の code を保つ）を確かめた。指摘は high 0・medium 1・low-medium 2・low 3、全部直して試験を足した。M1：usage の file の全文で `401` を探したので、session_id の中の数字で通ったと読めた → `\b401\b`・usage は `failure`・`turn_exit_reason` だけ。LM2：in-process の 401 は stdout の「rejected your API key」だけに出ることがある → 印に足す。LM3：python の許しが `installs` の `.leases`（sandbox の中で書ける）を通した → 頭が `.` の段を拒み `python3` だけ。L4：bootstrap を形だけで見ていた → 全文で照らす。L5：確かめの初めに前の起動を消す。L6：`_run_and_exit_oneshot` は上流でもう呼ばれていない＝引数の形を毎回確かめる。残り（受け入れ）：試験の偽物の main は `_try_fast_chat_launch`・`_prepare_agent_startup` を通らない（本物の通り道は Human の `--check-only` で見る）
