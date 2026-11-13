# Task Hub（共通の依頼窓口・権限の分類・安全な queue）

2026-11-09・MA-24。Mac Runtime で、外から来た信用できない依頼を「追跡できる task」に変え、**決まった安全な処理だけ**を無人で走らせるための部品。
破壊的な処理（メールの削除・送信、予定の変更、Secret、売買、権限、deploy）は handler として**存在しない**。台帳に宣言があっても、承認されても、ここでは実行されない。

## 1. 役割（指揮官は 1 人）

| 役 | 役割 | Task Hub との関係 |
|---|---|---|
| Grok Bot | 受付。人の言葉を依頼（envelope）にして VPS の受け口へ出す | 依頼元（source）。署名はしない（Bearer だけ）。封を作るのは受け口 |
| Hermes | 実行の主体（未接続） | `hermes.task` の宛先。inbox のフォルダが無い間は休眠 |
| Claude Code | 開発・運用 | この部品を作り・直し・結果を読む。承認はしない |
| Decision Layer | 分類 | Gateway の `executor-route` で「無人で走らせてよい候補か」を読む。**承認しない**（`policies/safety/human-only.json` は無変更） |
| Human | 承認 | 端末で `approve`／`reject` する唯一の主体 |

## 2. 流れ

```
依頼元 → VPS の受け口（Bearer を確認し、鍵で封に署名: scripts/lib/task-hub/wire.mjs）
      → inbox（*.json）→ intake: 封の署名・鮮度 → nonce（再送）→ envelope → 分類 → task
Human の CLI（submit）───────────────────────────────→ envelope → 分類 → task
task → [承認待ち] →(Human が端末で承認)→ queued → run → succeeded／retry_wait／failed
結果は outbox（依頼元＝人以外のとき）。配るのは別の部品で、配ったら outbox-sent へ移す
```

- `source`／`channel` は**封からだけ**取る。本文が何を名乗っても使わない（本文の未知の field は拒否）
- envelope v1：`{ v:1, idempotency_key, business, intent, params, summary? }`。承認を主張する key（`approved` 系・`forbidden_outcome_keys`）は params の深さを問わず拒否。鍵・token の形の値は拒否（`sk-`・`ghp_` 系・`etk_`＋64 桁 hex・**64 桁以上の hex の連なり**など。語頭は「英数字の直後でない」で見るので `token_ghp_…` も拾う。32 桁の id や git の sha は対象外）。不可視文字・制御文字（Unicode の Cf・Default_Ignorable・点字の空白 U+2800・制御・行／段落区切り）は NFKC のあと取り除く（id に入っていれば拒否。取る前と取った後の両方で Secret の形を見る＝挟んで隠せない）。`summary` はデータとして保存するだけで、命令としては読まない
- **大きさの上限は NFKC のあとで見直す**（1 文字が 18 文字に広がる文字がある）：1 つの文字列 2000 字・params 全体 14000 byte（封の body 上限）・summary 200 字。intent ごとの上限（既定 8 KiB）も正規化後の params で見るので、rejected の task にも上限を超えた params は保存されない
- params の上限は既定 8 KiB。メール・予定の要約だけ 14000 byte（封の body 上限 16 KiB に収めるため。**件数の上限（200／300）に届く前にこの byte 数が先に来る**。大きな一括は複数の封に分ける）
- **生産者（Grok・docomo-mail-lab の export など）への指示**：メール・予定の digest は **params ≤ 14,000 byte**（`JSON.stringify(params)` の UTF-8 byte 数）になるよう分割して出す。日本語のメール 1 件（件名＋送信者の表示名など）は約 380 byte なので **約 36 件が目安**で、200 件を 1 封には入れない。超えた時：params が 14,000 byte を超えると Mac の取り込みで `envelope_params_too_large`（task にならず、依頼元へ返事の `rejected`＋このコード）、intent の上限（`max_params_bytes`。メール・予定の digest は 14,000）を超えると task は作られるが `rejected`／`params_too_large`、封の body が 16 KiB を超えると VPS が `too_large`（isError）で受けない。分けた封は別の `idempotency_key` にする。**鍵・token の形の値（`sk-`・`ghp_`・`etk_`＋64 桁 hex・64 桁以上の hex の連なりなど）は params のどこにあっても封全体を拒否する**（Mac の取り込みで `envelope_secret_shaped_value`、依頼元へは `rejected`＋このコード。1 件でも混ざれば 1 封ぶん全部落ちる）ので、生産者が出す前にマスクする（件名に 64 桁の hex を含むメールは、その値を落としてから出す）

## 3. state

`awaiting_approval`／`queued`／`running`／`retry_wait` が途中。`succeeded`／`failed`／`rejected`（却下・形の誤り）／`blocked`（forbidden・handler 無し・台帳が変わった）／`expired`（承認待ちのまま 7 日）／`stopped`（中断で再開不可）が終わり。終わった task は動かない（出し直す＝新しい idempotency_key）。`stopped` は Human が `dismiss` で `failed`（`dismissed_by_human`）に閉じる（§8。再実行はしない。runtime-ops の「止まった task」の一覧から消える）。

| 初期の state | 条件 |
|---|---|
| `queued` | auto、または ai_check で Gateway が candidate |
| `awaiting_approval` | human_required（台帳に無い intent・source の allowlist 外・Gateway が human／review／失敗 を含む） |
| `blocked` | forbidden（承認できない） |
| `rejected` | params が台帳の形に合わない |
| 作らない | 知らない source／channel が許されない／business が許されない／署名・鮮度・再送・envelope の誤り（理由のコードだけ返し audit に残す） |

## 4. class と Gateway

- `auto`：ローカルで読む・自分の記録に書くだけ。`ai_check`：Gateway が `candidate` と読んだ時だけ無人。`human_required`：承認が要る（handler が無いものは承認後も `blocked/no_handler`）。`forbidden`：prefix（`trading.` `system.` `shell.` `secret.` `permission.` `gate.` `payment.` `account.` `hermes.toolset.` `vault.write` ほか）または台帳の宣言
- Gateway（`executor-route`・application `task-hub`・project `e-nexus-decision-layer`＝この repo 自身）へ in-process の SDK で聞く。input は intent の flags（構造情報）と intent 名だけ。**依頼の summary・params は渡さない**。env は空（`EDL_ALLOW_NETWORK` も環境の指定も読まない）。Knowledge は注入しない（`availability: not_checked`）
- 合成は**厳しくする方向にだけ**：`human`／`stop`／例外／環境の不一致＝少なくとも human_required。`review`＝ai_check は human_required、auto は flag が全部 false の時だけ残る。`candidate`＝変えない。実行の直前にも台帳・config を Gateway なしで見直す
- **executor-route の実際の答え**（rules だけ・Jev へ流れない）：`execution_mode: interactive` ＋ 危険な flag が全部 false ＋ environment dev で `claude-code`／`tier: auto`／`rule:default-no-knowledge`＝candidate。**`scheduled`／`long-running` は rules が常に human_review_required を返す**（常駐の実行主体 Hermes が未導入のため）ので、Task Hub の ai_check／auto を `scheduled` と申告すると全部 human になる。ここでは、1 回の短い同期処理で終わるローカルの記録処理なので `interactive`、影響するのはこの Mac の手元の記録だけなので `dev` と申告した（`policies/task-hub/intents.json` の `$comment`）。executor-route の rules は変えていない。`recommended_executor: claude-code` は実行主体の指名ではなく、「Human-only 境界に当たらない」という読みとして使っている
- candidate は許可ではない。許可は台帳（人が決めた class）と Human の承認だけ

## 5. 無人で走るもの／走らないもの

走る（読む・記録する・決まった文面を作るだけ。process を起こさず、通信しない）：

| intent | class | 内容 |
|---|---|---|
| `status.query` | auto | runtime-brief を読み、水準・要確認の件数・生成時刻だけ返す（`brief_path` が未設定なら失敗）。**`{ "detail": true }`（2026-11-13）**：区分ごとの水準（ok／warn／crit だけ・文も日数も値も無い＝runtime-brief の externalView と同じ範囲）・その business の Task Hub の件数（承認待ち・待ち・実行中・24 時間の失敗・止まった）・Hermes の業務の件数・定期の回のコード |
| `task.status` | auto | 同じ依頼元**かつ**同じ business の task の状態だけ。無い・別の business は `not_found`（存在を教えない）。自分自身の key を引けば `found`（state は running）。hermes.task は `hermes: { status, summary? }` も。**`{ "view": "recent"\|"awaiting_approval"\|"failed"\|"hermes", "limit": 1..20 }`（2026-11-13）**：自分の依頼の一覧（task_ref・intent・state・updated_at・code・Hermes の状態）を新しい順に。承認待ちは他の依頼元の分を件数だけ（`others_awaiting_approval`）。task_ref と view は片方だけ（両方・どちらも無い＝`params_task_ref_or_view` で failed） |
| `mail.digest.ingest` | auto | Grok が作った要約を business の記録に残す（id で重複除去）。メールの操作はしない |
| `calendar.digest.ingest` | auto | 同上＋重なり・重複の疑い（同題名＋同開始、または 90% 以上重なり題名が似ている）を検出 |
| `report.morning` | auto | その business 自身の記録から決まった文面（3000 字まで）。2026-11-13：今日・明日の予定と同じ `case_ref` のメモ（`■ 予定に関係するメモ`）・Mac の稼働状況（水準と件数だけ）・Hermes の業務の件数を足す。**記録（`records/<business>/`）と `report.morning` の範囲は business 単位で、依頼元（source）単位ではない**：同じ business に複数の source が書けば 1 つの記録に混ざり、`承認待ちのタスク N 件` もその business の全 source の承認待ちを数える。予定の照合は最大 500 件・50,000 組まで（超えたら「一部だけ照合」と出す）。3000 件の保存でも 1 秒未満 |
| `note.record` | ai_check | 短いメモ（500 字）を business のメモに追記。`case_ref`（任意・予定の case_ref と同じ値）で朝のまとめが予定と結ぶ |

走らない：`hermes.task`（承認が要る。**休眠**：`hermes_inbox` に設定されたフォルダが既に在る時だけ 1 file 書く。作らない。無ければ `hermes_inbox_not_connected` で終わり再試行しない）。台帳にだけ在り handler が無いもの：`freeform.request`・`mail.reply.draft`・`mail.send`・`mail.label`・`mail.move`・`mail.mark-read`・`mail.delete`・`calendar.event.create|update|delete`・`docomo.rule.propose`・`dropbox.read`・`github.read`。これらは追跡のために受けるだけで、承認しても `blocked/no_handler`。

runner：`run` の呼び出しごとに 1 回回って終わる（常駐しない）。lock・lease・指数 backoff（30 秒から、最大 1 時間、既定 3 回まで）・AbortSignal の timeout。**同期の handler は timer が回る前に終わるので、戻った後の実時間も測り、`timeout_ms` を超えていたら timeout として扱う**（結果は捨てて再試行の道）。lease の切れた running は、handler が resumable なら checkpoint を残して queued に戻し、そうでなければ `stopped`（`interrupted_not_resumable`）。想定外の失敗が連続 3 回で `PAUSE` を書いて止まる（消すのは Human）。**連続回数は store の `breaker.json` に残り、`run` の呼び出しをまたいで数える**（`--max 1` を繰り返しても 3 回で止まる。成功で 0、PAUSE を書いたら 0 から）。休眠・未設定のような想定内の失敗は数えない。

## 6. 承認とその限界

- `approve`／`reject` は `awaiting_approval` だけ。**端末（stdin と stdout が TTY）でなければ拒否**（agent・自動化・パイプは承認できない）。`show` が出す確認コード（content_digest の先頭 12 桁）を打つ＝見た内容への承認。
- **承認の対象は params の全文**（確認コードは全文の指紋）。だから承認待ちの task の `show` は params を**省略せず全文**で出す（キーの順は固定・見えない／紛らわしい文字＝bidi・零幅・制御・未割り当て・空白類は `\uXXXX` で表示して隠さない）。`human` の一覧は承認の前に `show` で全文を読むよう添え、`approve` は（端末・確認コードが通った後）**記録する直前にもう一度全文を表示する**。承認待ち以外の state の `show` は読みやすさのため値を 200 字・配列を 20 件・深さ 4 で省略する（承認の対象ではない）承認は digest と 24 時間の期限つきで、runner は実行の直前に今の内容の digest と一致するか・期限内かを見て、違えば承認待ちに戻す（params を書き換えると再承認）
- `human` の一覧と outbox には確認コードを出さない
- **限界**：TTY と確認コードが止めるのは「非対話の自動承認」まで。同じ OS ユーザーの別 process が pty を持てば満たせるので、**強い本人確認ではない**。共有ユーザーの Mac では特にそう。より強い確認（別ユーザー・別の端末・鍵・生体）は Human の判断（未実施）
- Decision Layer・runner・依頼元のどれも承認しない。承認の記録（`approval`）を書くのは `approve` だけ

## 7. 保存先（`~/e-nexus-runtime/mac-runtime-state/task-hub`・dir 0700／file 0600・repo の外）

`config.json`（local config・repo に置かない・他人が書ける権限だと読まない）／`tasks/`／`keys/`（(source, key) の重複の印）／`nonces/`（封の最大の古さ 8 日＋1 日残す。封が受け付けられる間は再送を replay として拒否できる）／`audit.jsonl`＋`audit.tip`（追記だけ・各行に前の行の sha256・params の値や Secret は書かない）／`outbox/`・`outbox-sent/`／`records/<business>/{mail,calendar,notes}.jsonl`／`breaker.json`（想定外の失敗の連続回数）／`hermes-jobs/`（Hermes の 1 件実行の記録・2026-11-13）／`hermes-work-logs/`（Hermes の出力の末尾・鍵の形を伏せる）／`run.lock/`・`locks/*.lock/`／`PAUSE`。

- **記録の保持**：取り込みの最後に畳む（`prune` でも）。メールは受信から 30 日・予定は終わって 14 日／始まりが 120 日先までを残し、同じ id の古い版を落とし、件数は mail 5000・calendar 5000・notes 2000 を上限に新しい方から残す。file は有限
- **lock**：owner.json を入れた一時フォルダを rename して取る（取れた瞬間に持ち主が書かれている）。**持ち主の pid が居ない時**か、起動時刻（`started_at`）から上限（audit・task の lock は 60 秒・run の lock は 30 分。本物の持ち主はそれ以上持たない）を超えた時（pid の再利用）だけ古いとして取り除く（上限内の生きた持ち主の lock は奪わない＝監査の鎖が分岐しない。待てば `lock_timeout`）。取り除く時は lock を一時の場所へ動かして持ち主を確かめ、違えば戻す（戻せなければ `lock_conflict`）。持ち主は監査の追記の直前に今も自分の lock か確かめ、違えば書かず `lock_lost`。owner.json の無い lock は 60 秒より古い時だけ
- **読み方**：task・outbox・記録・inbox の file は開く時に `O_NOFOLLOW`＋`O_NONBLOCK`、fstat で通常ファイルかつ上限以下の時だけ読む（FIFO で止まらず、symlink をたどらない。`scripts/lib/task-hub/safe-read.mjs`・runtime-ops の件数も同じ）

local config：`{ "sources": { "<source>": { "channels": [...], "businesses": [...], "intents": [...任意の allowlist] } }, "businesses": [...], "hermes_inbox": "/abs", "brief_path": "/abs", "utc_offset_minutes": 0 }`。Human の CLI は `human-cli`（channel `local-cli`）を宣言した時だけ使える。

## 8. CLI（`node scripts/task-hub.mjs`）

`intake --inbox <dir>`／`submit --file <json>`／`list [--state s] [--business b]`／`show <id>`／`approve <id> --confirm <12hex>`／`reject <id> --confirm <12hex>`／`dismiss <id> --confirm <12hex>`（止まった `stopped` を確認して `failed`／`dismissed_by_human` に閉じる。approve と同じく端末が要る。`show` が stopped の確認コードを出す）／`run [--max N]`／`verify-audit`／`human`（`[承認待ち] <business> <intent> <task_id> …`・runtime-ops が使う）／`prune`（古い nonce・配達済みの outbox・保持を過ぎた記録・途中で止まった tmp）。共通：`--store`・`--config`。終了コード 0＝ok／1＝問題あり／2＝使い方の誤り。
`intake` の channel の鍵は Keychain（`E-NEXUS/edl/task-intake-<channel>`・hex 64 桁以上）から読む。値は表示しない。**`security` が exit 44（項目なし）の時だけ**「知らない channel」として拒否する。時間切れ・ほかの exit code・signal・値の形が悪い時は coded error（`keychain_unavailable`／`keychain_failed`／`keychain_value_invalid`）で、その file は inbox に残り次の回でやり直す（Keychain の一時的な故障で依頼を捨てない）。鍵は process の中で channel ごとに 1 回だけ読む。Keychain の読み取りは `intake` を Human が実行した時だけ起きる。

## 9. あとで接続する手順（Human）

1. **VPS の受け口**：受け口が封を作り、inbox に `*.json` を**一時名で書いて rename**（途中の file を読ませない）。channel ごとの鍵を Keychain に登録（登録・配置は Human）
2. **Mac の取り込み**：local config を作る（source と channel と business の対応）→ `intake` を手で実行して様子を見る → 定期化は別途 Human が決める
3. **返信**：別の部品が outbox を読んで `wire.sealStatus` で署名し VPS の状態の板へ送り、配ったら `markDelivered`
4. **Hermes**：Hermes の inbox・outbox のフォルダを **Human が作り**、config の `hermes_inbox`・`hermes_outbox` に書く。それまで `hermes.task`・`collect-hermes` は休眠。権限の範囲・費用・検収は `docs/hermes-work.md`
5. **VPS の保守と Cloudflare・Bot の登録**：`docs/vps-maintenance.md`（1 回の ssh にまとめた手順と検収）

## 10. ロールバック

CLI を実行しなければ何も動かない（常駐なし・launchd なし）。止める＝`PAUSE` を書く、または store のフォルダを消す。repo 側の新規 file（`policies/task-hub/`・`scripts/task-hub.mjs`・`scripts/task-intake-sync.mjs`・`scripts/lib/task-hub/`・`deploy/vps-task-intake/`・`tests/task-hub*`・`tests/vps-task-intake.test.mjs`・本書）は消すだけで戻る。**既存の file も次の分は変更している**ので、戻す時はこれらも戻す：
- `scripts/runtime-ops.mjs`（`taskHubCounts`・`humanRequired` の `taskHub` 引数＝承認待ち・止まった task・PAUSE の件数を Human への一覧に足す）と `tests/runtime-ops.test.mjs`
- `registries/agents.json`（Hermes の description・trigger。status は planned のまま）と `tests/executor-route.test.mjs`（その文言）
- `deploy/vps-heartbeat/receiver.mjs`・`README.md`（途絶を送れないうちに復旧した時の「途絶と復旧」の 1 通。task-hub とは別件の修正）と `tests/heartbeat.test.mjs`

## 11. 既知の限界

- **nonce を取った後の失敗**（lock_timeout・disk のエラーなど）：取り込みは nonce の印を外してから失敗を返すので、inbox に残った file が**次の回でそのまま取り込まれる**（以前は印だけが消費されて replay として捨てられ、依頼が消えた）。外せなかった場合も印は途中（pending）のまま残り、60 秒の後の回が引き継いで取り込み直す（2026-11-10）。それでも詰まった依頼は依頼元が**新しい `idempotency_key` で出し直す**。同じ key の出し直しは VPS 経由では効かない（VPS は取得済みの key を `seen` で 14 日覚えていて、同じ key を重複として黙って捨てる。Mac 側の `keys/` の印でも同じ内容は 1 件に収まる）。詰まった依頼を出し直す時は必ず新しい key を使う
- **`approve` は表示の直後に記録する**：端末・確認コードが通ると全文を表示してすぐ承認を記録する（その間に止める確認は無い）。**判断の場は `show`**（承認の前に必ず全文を読む）。表示を見てから取り消す仕組みは無い
- `show` の escape が出せない：結合文字（combining mark）を重ねた装飾（打ち消し線・Zalgo など）と、見た目が同じ別の文字（キリル文字の a など）は区別しない。重ね書きで読めない文字列は params の全文を別の手段（`--file` の JSON など）でも確かめる
- VPS の queue で Mac が残している封（鍵の設定・時刻・版の違いかもしれないもの）は、`task-intake-sync pull` が読み飛ばして後ろの有効な封を取る（1 回で最大 10 ページ）。残している封があれば出力の `kept` に件数が出て **exit 1** になる＝止まっている依頼が定期実行の失敗として見える。原因（鍵・時計・版）を直せば次の回で取り込まれ、7 日で VPS が捨てる
- outbox の結果を VPS が永久に拒む場合（`unknown_source` など）は、`outbox-rejected/`（outbox の隣・0700）へ退避して毎回送り直さない（`quarantined` に数える。削除はしない）
- lock の持ち主は pid だけでなく起動時刻（`started_at`）でも見る：audit・task の lock は 60 秒、run の lock は 30 分を超えたら（pid が別の process に再利用されていても）古いとして引き継ぐ。`run` が lock を取れず、持ち主が 30 分を超えていれば exit 1、lock の競合（`lock_conflict`）は audit に残して走らない
- **lock の確かめと書き込みは原子的でない**（受け入れた残り・2026-11-10）：持ち主は書く直前に `owns()` で確かめるが、その直後から書き終わるまでの間に持ち主が上限（60 秒）より長く止まると（SIGSTOP・スリープの復帰など）、別の process が古い lock として引き継ぎ、両方が書きうる。監査の鎖が分かれた場合は `verify-audit` が `chain_broken` として見つけ、**Human が `runtime-ops human`・`overview` を実行した時に priority 1 で出す**（読むだけ・2026-11-10）。無人の見張りは §13（2026-11-11 から既定で有効）。task の記録は state の遷移の検査で、終わった task を動かさない。OS の排他（flock）は node に無く、依存を足さないため、防ぐのではなく見つける形にしている
- **作る時は監査が先**（2026-11-10 再検証）：新しい task は監査の `created` を書いてから task の file を書く。監査が書けなければ task は無く、取り込みは nonce を外して失敗し、次の回に印の id で作り直す（監査は `created`・`recovered`）。作った直後のまま（履歴 1 行）の task への重複は outbox の知らせを書き直す（前の回が outbox の前に止まっていても依頼元が状態を知れる。時刻は task の `updated_at` のまま＝後の承認・却下の知らせを追い越さない）。**強制終了の後**（2026-11-10）：nonce の印は「取った時刻＋pending」で、取り込みが終わると `done` になる（1 行だけの古い形は終わった印）。印を終わらせられない時（disk のエラー）は監査に `nonce_finish_failed` を残して投げる＝file は inbox に残り、次の回で終わらせ直す（task にならなかった封はその時の policy でもう一度判定される）。終わっていない印（前の回が task を書き終える前に止まった）は replay にせず、印に書いた時刻（その intake の回の開始の時刻）から 60 秒未満なら `nonce_busy`（file は inbox に残る）、それより古ければ引き継いで取り込み直す（重複は (source, key) の印で 1 件に収まる・監査には task の無い `created` が 1 行残りうる）。nonce などを O_EXCL で作って書けなかった時（disk full）は空の file を残さない
- **終わった印の後・done への移動の前に止まった封**（2026-11-10 監査 F8・受け入れた残り）：次の回は `replay` として rejected/ へ移し exit 1 になるが、task は 1 件できている（`list` で確かめられる）。同じ封の再送を見える形（replay・rejected）に保つため、この狭い窓のために replay の扱いは変えない
- `intake` の CLI は `run` と同じ単独実行の lock（`run.lock`）を取る：持たれている間は取り込まず exit 0（file は inbox に残る。持ち主が 30 分を超えていれば exit 1）。2 つの intake が同じ file を同時に読み、片方の失敗の後にもう片方が replay として捨てるのを防ぐ
- `task-intake-sync pull` は、新しく置いた封が無く既にあった封（existing）だけの回もフォルダを fsync してから ack する。macOS の fsync は F_FULLFSYNC ではない（OS の cache までは確実・disk の書き込み cache の電源断には弱い。node に F_FULLFSYNC は無い）
- `task-intake-sync` の 1 回の運び（pull の各ページ・ack・push）は、要求の時刻を 1 つの時計（`requestClock`）で必ず前より大きくする（2026-11-10。以前は時計が同じ ms のままだと 2 ページ目が VPS に再送として拒まれ exit 1 になった）
- メールの「返信済み」の印は無く、取り込み直しで category を変えると閉じる（返信待ちは受信から 14 日で数えなくなる）
- handler が AbortSignal を聞かない非同期処理だと timeout 後も裏で動き続けうる。同期の handler は止められず、戻った後に timeout として扱うだけ（今の handler は短い同期処理）
- `show` の escape は見えない・紛らわしい制御／空白類の文字を出すが、見た目が同じ別の文字（キリル文字の a など）は区別しない。承認の最後の保証は Human が全文を読むこと（結合文字の重ね書きも同様。上の項）
- 監査の鎖は末尾の削除を `audit.tip` で見つけるが、store の書き込み権限を持つ者が鎖ごと作り直すのは防げない（同じ OS ユーザー内の改ざんは範囲外）
- executor-route の rules が将来変わって `interactive` でも human を返すようになったら、全部が承認待ちになる（fail-closed。`tests/task-hub-e2e.test.mjs` が検知する）

## 12. 通知（Discord）の整理（案・2026-11-10）

既存の監視の Webhook（host-health・heartbeat の受け側）はそのまま。**新しい Webhook・新しい定期の通知は足していない**（足すのは Human の承認）。

| 通知 | 今 | 案 |
|---|---|---|
| 異常（Mac・Hermes・バックアップ・生存信号の途絶） | host-health と VPS の受け側が Discord へ（普段は静か・`docs/runtime-monitoring.md`） | 変えない |
| Task Hub の承認待ち・止まった task・PAUSE・監査の鎖の破損・outbox の隔離 | `runtime-ops human` の一覧に件数だけ。**2026-11-13 から承認待ちは host-health の既存の回の WARN（件数だけ・§15）** | 承認は Discord のボタンではなく Mac の端末だけ（変えない） |
| task の完了 | 依頼元（Grok Bot）が `get_task_status` で見る | Discord へは送らない（Bot と Discord の二重を避ける。依頼した側へ返すのが 1 本の経路） |
| 通知の失敗・再送 | host-health・受け側はそれぞれ失敗を数えて再送（受け側は 5 分ごと・未送信を消さない） | 変えない |

- **情報漏れの防止**：Discord へ出すのは固定の文と件数だけ（`lib/alert-policy.mjs` の形）。依頼の本文・メールの件名・宛先は出さない
- **Grok Bot との重複**：Bot の朝の報告（Gmail・予定）は Bot の中で完結。Task Hub は Bot が渡した集計を記録するだけで、同じ内容を Discord へ流さない
- 承認待ちを Discord へ出す変更（host-health の項目を 1 つ足す）は Human の判断の後に作る。検収：承認待ちを 1 件作り、次の回で WARN が 1 通・本文に件数だけ・24 時間は重ねない

## 13. 監査の鎖の無人の見張りと、壊れた時の手順（2026-11-10）

**見張り**（2026-11-11 から既定の保存先に `config.json` があれば有効。§14）：host-health に `--task-hub <保存先の絶対 path>` を渡した時か、既定の保存先に config.json がある時、毎回（:20・:50）監査の鎖を読むだけで確かめる（`lib/task-hub/audit-watch.mjs`。store を開かない・作らない・直さない・上限 32 MB）。

- 正常：`task_hub_audit` が ok の 1 項目として記録されるだけ（通知しない）
- 鎖が壊れている（`chain_broken`・`unparseable`・`truncated`・`tip_mismatch`・`tip_missing`）：crit。hold 0 ですぐ 1 通、本文は固定の文と**コードだけ**（task の id・中身・path は出さない）。新しいコードが増えた時だけ知らせ直す
- 読めない（`audit_unreadable`・`audit_unreadable_or_large`〈32 MB 超え〉・`check_failed`）：warn
- 有効にする（Human・launchd の登録の変更）：`node scripts/scheduled-job-service.mjs install --job host-health --target launchd … --task-hub ~/e-nexus-runtime/mac-runtime-state/task-hub`（今の引数に足すだけ）。検収：store の写しで `audit.jsonl` の途中の 1 行を書き換え、`node scripts/host-health.mjs --state-dir <一時の dir> --no-guard --task-hub <写し> --json` が `task_hub_audit` crit・`chain_broken` を返す。本物では正常の回に通知が出ないこと
- 戻す：`--task-hub` を外して入れ直す

**強制終了で tip だけ遅れた形**（追記の後・tip を書く前に止まった）は異常ではない：tip が file の頭の行と一致し、後ろに行が足されている形は、次の監査の書き込みが数え直して直す（`store.audit`・2026-11-10 監査 F1）。file が tip より短い・tip の位置の行が違う形（末尾の削除・改ざん）は直さない＝異常のまま残る。

**壊れた時の手順（Human）**：

1. `node scripts/task-hub.mjs verify-audit` でコードと行の番号を見る。**確かめるまで承認しない**（runner・approve は鎖を見ないので、自動では止まらない。止めたい時は `PAUSE` を書く）
2. `chain_broken`：その行の前後を読む（`sed -n '<n-2>,<n+1>p' audit.jsonl`）。同じ `prev` の 2 行＝2 つの書き手の分岐（§11 の lock の限界。task の state は遷移の検査で守られる）。それ以外の書き換え＝改ざんの疑い。task の file・`history` と照らす
3. `truncated`・`tip_mismatch`：バックアップ（`runtime-backup`）の同じ file と比べ、消えた行があるかを見る
4. 原因が分かったら、壊れた log を `audit.jsonl.broken-<日付>` に改名して残し（消さない）、`audit.tip` も同じく改名する。次の書き込みが新しい鎖を 1 行目から始める。改名と理由は作業ログに残す

## 14. 本番の回（2026-11-11）

- **保存先の本番の設定**：`~/e-nexus-runtime/mac-runtime-state/task-hub/config.json`（repo の外・0600）。第 1 段（Human 指示 2026-11-11）：VPS から来る source は `grok-commander`（EN司令塔）だけ・business は `e-nexus` だけ・intents は `status.query`・`task.status`・`report.morning`・`note.record`＋`hermes.task`（2026-11-11 Human 承認。**毎回 Mac の端末での承認が要る**・承認の前に Hermes へ渡らない）。E-STEP・個人・メールの操作は含めない（VPS の `add-source` でも同じ intents に絞る＝2 重。`connect-from-mac.sh`・`vps-apply.sh` は `--source` に `--intents` を必須にする）。`human-cli` は Human の端末からの依頼
- **1 回の回し**：`node scripts/task-hub-cycle.mjs`＝VPS から pull → intake → run → collect-hermes → push（run は 120 秒・ほかの段は 45 秒で打ち切り・既定 5 件・出力は段ごとのコードだけ。Hermes の 1 件実行の間＝印 `hermes-run.active` がある間は collect-hermes を呼ばない）。config.json が無ければ何もしない。最後の結果を `cycle-last.json` に残す
- **定期の回**：`deploy/macos/connect-task-hub.sh --apply`（LaunchAgent `com.e-nexus.task-hub`・5 分ごと・常駐しない・Background。**新しい LaunchAgent なので Human の承認の後だけ**）。host-health の中では回さない（host-health は 1 回 60 秒の期限があり、VPS への通信の遅れで監視本体を巻き込まない）
- **見張り**：host-health は config.json がある時、`--task-hub` が無くても既定の保存先の監査の鎖（§13）と `cycle-last.json` を読む（読むだけ）。`task_hub_cycle`：ok／`paused`（Human の PAUSE の間は run を呼ばない＝失敗に数えない）／`paused_breaker`（runner の回路遮断＝warn）／`not_configured`（Keychain に VPS の URL か鍵が無い）／`problem <段>`／`stale`（30 分以上回っていない）。`not_configured`・`stale` は LaunchAgent の plist がある時だけ。warn で、45 分続いた時に 1 通
- **Hermes の結果の返却**：`collect-hermes` は依頼元が人以外の時、結果の板へ同じ `task_ref` の新しい知らせ（`result.hermes = { status, summary }`）を書く（板は新しい `updated_at` が勝つ）。Grok Bot は `get_task_status` で Hermes の要約まで見える
- **止める**：`connect-task-hub.sh --remove`、または保存先に `PAUSE`。VPS の入口を止める時は Cloudflare の hostname を消す（`deploy/cloudflare-task-intake/README.md`「戻す」）

## 15. 仕事の見張り（2026-11-13・host-health の既存の回・読むだけ）

新しい Webhook・LaunchAgent は足していない。host-health（:20・:50）が store の file を読むだけ（`lib/task-hub/audit-watch.mjs` の `taskHubWorkItems`・`lib/docomo-watch.mjs`）。値は件数かコードだけで、文は `lib/alert-policy.mjs` の固定文。

| 項目 | warn の時 | 通知 |
|---|---|---|
| `task_hub_approval` | 承認待ちが 1 件以上（全 business・全依頼元の件数） | 次の回に 1 通（hold 0）。続いている間は重ねない。0 に戻って新しく来たらまた 1 通 |
| `task_hub_queue` | `stalled`（queued・時刻の来た retry_wait が 30 分動かない＝定期の回が実行できていない）・`stopped`（Human の dismiss 待ち） | 2 回分続いたら 1 通。新しいコードが増えたら知らせ直す |
| `hermes_jobs` | `stuck`（running のまま 20 分）・`not_run`（承認済みで 24 時間未実行）・`timeout`・`no_result`・`result_rejected`・`interrupted`（24 時間以内） | 次の回に 1 通。新しいコードで知らせ直す。Hermes 自身の failed（「できない」）は依頼元へ返る普通の結果なので知らせない |
| `docomo_fetch` | docomo-mail-lab の `bin/dml-fetch.mjs` が 3 回続けて失敗（`fetch-last.json` が無い間は項目なし） | 次の回に 1 通 |

`runtime-ops human` にも `task-hub:hermes`（Hermes の業務のコード）を足した。正常な回・完了の知らせは Discord へ送らない（完了は依頼元の Grok Bot へ返す 1 本の経路）。

## 16. VPS の受け口の business の制限（2026-11-13）

鍵（source）ごとに `businesses` を VPS でも絞れる（`deploy/vps-task-intake/intake.mjs`：`business_not_allowed`）。Mac の config の `businesses` と 2 重で、Grok Bot の説明文（コネクタはアカウント全体で共有されうる）だけに頼らない。適用は Human の 1 コマンド（`connect-from-mac.sh … --intake --source grok-commander --intents <今と同じ> --businesses e-nexus`。登録済みの bot は鍵を作り直さず intents・businesses だけ替える）。後の保守で `--businesses` を省いても制限は外れない（今のまま）。外すのは `--businesses all` を明示した時だけ。
