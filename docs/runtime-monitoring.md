# Mac Runtime の監視と連携の仕様

host-health を中心にした、決定的な監視（AI を呼ばない）の契約。正本は Vault の MA-22 ランブック §9-4・§11 と MA-24 で、ここは repo 側の実装の説明。
**この repo は公開なので、ホストの現在の状態・Trading Lab の詳細はここに書かない**（private の Vault へ）。

## 1. 構成

| 部品 | 役割 | 既定 |
|---|---|---|
| `scripts/host-health.mjs` | 30 分ごとの 1 回分：集める・判定する・記録する・変化を知らせる | 通信なし（`--webhook`・`--github-owner` を付けた時だけ） |
| `scripts/lib/runtime-guard.mjs` | Hermes の常駐と隔離・repo・relay・バックアップ・設定の改変 | host-health の中で動く |
| `scripts/lib/github-guard.mjs` | GitHub の公開範囲・CI・repo の異常 | token が Keychain にある時だけ（§4） |
| `scripts/lib/heartbeat.mjs`・`deploy/vps-heartbeat/` | 外部の死活監視（§3-1） | Keychain に入るまで何もしない・VPS の導入は Human |
| `scripts/lib/alert-policy.mjs` | 知らせる基準と本文の文（§2） | host-health の中で動く |
| `scripts/lib/quarterly-report.mjs` | 四半期の運用要約（§2-1） | host-health の中で動く |
| `scripts/host-health-watchdog.mjs` | host-health の停止を別の job から見る | 毎時 :35。監視専用で何も再起動しない |
| `scripts/lib/runtime-status-summary.mjs` | Hermes へ渡す要約（§6） | host-health の中で動く |
| `scripts/lib/runtime-brief.mjs`・`ops-classify.mjs` | Hermes へ渡す整理済みの要約・入力境界・項目の仕分け（§6-1） | host-health の中で動く |
| `scripts/runtime-ops.mjs` | 検収・原因調査・Human Required の集約（§11） | 手で実行する。読むだけ・常駐しない |
| `scripts/runtime-status-summary.mjs` | 要約を手で見る | 標準出力か一時フォルダだけ |
| `scripts/backup-*.mjs` | 暗号化バックアップ（§5） | 条件が揃うまで何も送らない・job の登録は Human |

監視は決定的なコードで回す。理由：常時の見回りに課金を載せない・判定を再現できる・Hermes の権限を増やさない。

## 2. 通知（Discord）

**普段は静かに監視し、本当に必要な時だけ Human に知らせる**（2026-11-05 Human 決定・E-NEXUS の標準方針）。基準は `scripts/lib/alert-policy.mjs`、判定は `host-health.mjs` の `decide`。
宛先は専用チャンネルの専用 Webhook。URL は Keychain の `E-NEXUS/edl/host-health-webhook` だけに置く（引数・ファイル・Git に置かない）。

| 種類 | Discord | 詳細 |
|---|---|---|
| 正常 | 送らない | 30 分ごとの記録だけ |
| 一時的な異常 | 送らない | WARN が 24 時間に満たない間は記録だけ。2 回続けて ok なら数え直す |
| 続く WARN | 1 回 | 24 時間続いた時に 1 回だけ。再通知なし・回復の通知なし |
| CRIT（重大） | すぐ 1 回 | 新規と WARN からの悪化 |
| CRIT の継続 | 控えめに再通知 | 24 時間後・その 48 時間後・96 時間後…（上限 7 日）。WARN へ下がった間は黙り、24 時間以上あいて CRIT へ戻れば知らせる。隔離・user 範囲は新しいコードが増えれば知らせ直す |
| 回復 | 1 回 | CRIT を知らせた項目だけ、2 回続けて ok になってから。送れない間に解消した CRIT も、送れるようになった回に 1 回（回線断は送信も失敗するので） |
| 行き来する CRIT | 間引く | 回復を知らせてから 6 時間は重ねない。続いていれば明けた回に知らせる（隔離・電源・回線・監視の停止は待たない） |
| 重大な出来事 | すぐ 1 回 | 再起動・監視の空白・Hermes の固定ファイルの変化・監視の定義と安全 policy の変化・常駐の増減・GitHub の公開範囲と既定 branch の変化。同じ項目の同じ値が毎回続く時だけ 24 時間に 3 通まで（値が違えば別に数える・CRIT は上限の外・超えた分は明けた回に 1 通） |
| 軽微な出来事 | 送らない | 回線の切替・Hermes の再起動。24 時間に 3 回繰り返した時だけ 1 回 |
| 重大の行き来（電源・回線・ディスク・メモリ・Hermes・隔離・監視の停止）と再起動・監視の空白の繰り返し | 「反復」を 1 通（GitHub の見張りの失敗は WARN なので上限だけが効く） | 1 回目はふつうに知らせる。24 時間に 2 回目で「反復」を 1 通送り、24 時間は静かにする。明けた時に重大が続けば再通知、落ち着けば回復を 1 回（回線断で送れないまま繰り返した時は、反復の 1 通で終わる）。**項目ごとに直近 24 時間で 3 通が上限**で、超える分は持ち越す。回線断で送れなかった回も数える。隔離の新しいコードだけは上限を待たない。原因は断定しない。上限は項目ごとで、同じ停電で電源と回線の両方が出ることはある |
| 監視の停止 | すぐ 1 回 | §3。`DISABLED` の間は 24 時間ごと。`monitor_alive`・`monitor_watchdog` は CRIT の継続と同じ間隔 |
| 運用要約 | 四半期に 1 通 | §2-1 |

項目ごとの例外：Hermes の停止は 1 時間（3 回の観測）続いたら重大として扱う（再通知と回復の通知あり）。user 範囲の指示の混入は WARN でも待たない。`repo:`・`relay_outbox` は WARN になるまでの猶予が 24 時間あるので、知らせるのは 48 時間後。`backup_time_machine` は 3 日で WARN なので 4 日後。

繰り返す短い WARN（毎回 24 時間に届かない）は知らせない（累積では見ない）。重大が続く間の値の悪化（ディスクの空きがさらに減るなど）は次の再通知まで知らせない。送れた印を残せない時は送らない（記録を書けない間に同じ通知を重ねない。§3）。

- 送れなかった分は次の回にもう一度（30 分に 1 回まで。出来事の基準も進めない）。`PAUSE` の間は記録だけで、状態も出来事の基準も進めず、明けた後に知らせる
- `PAUSE` は 72 時間で効かなくなる（消し忘れで全部が黙らないように。`monitor_pause=expired` の WARN）。mtime が未来の `PAUSE` は 10 分先までしか効かない（時計の小さな戻りだけ許す。前は期限の 2 倍＝最大 144 時間黙れた）
- 本文は 1 行に「対象：何が起きたか → 対応」だけ（例：`【重大】起動ディスク：空きが少ない（18.2） → 要対応`）。文は固定で、値は項目ごとの形（`VALUE_SHAPES`）に合うものだけ通し、それ以外の文字列は `[redacted]` にする（allowlist。項目を足す時はここへも足す）。先頭は `[E-NEXUS Mac Runtime host]`（Trading Lab の通知と取り違えない）。詳細は内部の記録（`YYYY-MM.jsonl`）に残す
- Discord の mention は `allowed_mentions` で全部無効。`discord` 形式の宛先は Discord の webhook の形だけ・redirect に従わない
- 宛先が Discord の webhook なら本文は常に Discord の形（`--webhook-format` の付け忘れで送れなくならない）
- 回復は今回見なかった項目には出ない（外した repo などは state から消える）

### 2-1. 運用要約（四半期）

暦四半期（1・4・7・10 月）の最初の日の 9 時（日本時間）より後の最初の回に、前の四半期を 1 通だけ送る。既存の host-health の job の中で動く（常駐を増やさない）。毎日・毎週・毎月の正常報告はしない。

- 本文は集計の数だけ（稼働率・欠落の回数・重大の件数と対応済み・未解決・軽微な警告・出来事・host-health が送った通知。watchdog の通知は数えない）。項目名・値は載せない（`scripts/lib/quarterly-report.mjs`）
- 送れない時は 6 時間あけて 8 回まで。それでも送れなければその四半期は諦める（`QUARTERLY_GAVE_UP` を記録）。Mac が止まっていて飛ばした四半期は積み上げず、最後の 1 通だけ
- `PAUSE` の間は送らない。state を失った時は同じ四半期を二度送らない側へ倒す
- 下見：`node scripts/host-health.mjs --quarterly-preview [--period 2026Q4]`（送らない・何も書かない）
- **四半期の要約が届かなければ、それ自体が監視の停止の手がかりになる**（§3 の未カバーの最後の網）

### 接続（Human の操作）

1. Discord で専用チャンネルとそのチャンネル専用の Webhook を作る
2. Mac の Terminal で `bash deploy/macos/connect-discord-alerts.sh`（URL の入力はマスクされる。Claude Code の `!` では実行しない）
3. チャンネルに「配送試験」が届き、スクリプトが OK と言えば完了。登録済みの job が `--webhook` を持っていなければ NG と言う

## 3. 監視の停止を見つける

| 止まり方 | 見つけ方 |
|---|---|
| 例外が 3 回続いた | `DISABLED`＋CRIT の通知。止まっている間も 24 時間ごと。Human が消した後は数え直す |
| 記録を書けない | 回数を残せないので時刻の枠で CRIT を知らせる（6 時間ごとの最初の 30 分＝1 日 4 通。`DISABLED` の間に書けなくなった時も同じ。他の通知は送らない） |
| 全体の時間切れ（60 秒） | 失敗に数える（上と同じ） |
| 一時的に止まって再開した | 再開した回に `monitor_gap`（最後の成功から 90 分を超えた空白。再開の回が失敗しても持ち越す） |
| job の解除・ハング・記録の途絶 | `host-health-watchdog`（別の job。`DISABLED` は本体の担当で重ねない）。Mac の再開の直後（起動から 90 分以内・自分の前の回から 90 分超）は判定しない＝偽の CRIT を出さず、次の回に判定する |
| 共有のコードの破損（編集の失敗で import が落ちる） | 両方の job が止まるので、watchdog の入口（`host-health-watchdog-launcher.mjs`・依存なし）が固定の文で知らせる（24 時間ごと）。入口そのものの破損は §3-1 の途絶で見る |
| watchdog の解除・ハング | host-health の `monitor_watchdog`（解除＝CRIT・記録が 3 時間途絶＝CRIT・plist を消せば `residents_changed`）。未登録なら `not_installed` で異常にしない |

watchdog は監視専用：Hermes・Mac・Trading Lab を含めて何も再起動しない。戻し方は `launchctl bootout gui/$(id -u)/com.e-nexus.host-health-watchdog` の後に plist を消す（1 回だけ `residents_changed` と `monitor_config_changed` が届く）。登録も戻すのも :21〜:34 か :51〜:19 に、続けて実行する（間に host-health の回が入ると `not_loaded` の偽の CRIT が出る）。

### 未カバー（Mac の上の監視では知らせられない）

| 止まり方 | 残る手がかり |
|---|---|
| host-health と watchdog が同時に止まる | 再開した時の `monitor_gap`。再開しなければ四半期の要約が届かないこと。§3-1 の導入後は 70 分ほどで途絶として届く |
| Mac の停止 | 再開した時の `rebooted`・`monitor_gap`。§3-1 の外部の死活監視の導入後は 70 分ほどで届く |
| 回線断 | 監視は動き続けるが送れない。戻った回に通知（`recovered_missed` か続く CRIT） |
| 読めない状態が続く項目（`df` の形の変化など） | `unknown` は悪化も回復も作らないので、24 時間続けば `monitor_blind`（件数だけ）を 1 回 |
| 記録を書けない間に起きて解消した CRIT | 通知は送らない（§2）。戻った回の `monitor_gap` と記録だけ |
| Webhook の失効・Discord の障害 | 1 日 1 回 GET で確かめる（何も送らない・`notify_channel`。`ok` 以外の間は毎回）。失効はその Webhook では知らせられないので、要約と `runtime-ops human` に出る。回線の問題は `unreachable` で鳴らさない |
| スリープの窓 | host-health の後に眠り、起床で watchdog が先に動くと、間が 90 分未満なら偽の CRIT が 1 度出る（この Mac は常時稼働の前提） |
| `DISABLED` を :20〜:35 に消す | watchdog が先に回ると古い記録を見て偽の CRIT が 1 度出る |
| `DISABLED` のまま job が起動しなくなる | watchdog は `DISABLED` を本体に任せるので、本体の 24 時間ごとの通知が止まっても知らせない |

### job の失敗・欠落（2026-11-05 追加）

| 止まり方 | 見つけ方 |
|---|---|
| 異常終了 | `job:<name>` の WARN（`exit N`・`signal N`。§2 のとおり 24 時間続けば 1 回） |
| 定期の時刻に起動しない | `runtime-backup`：launchd の `runs` が 30 時間増えなければ `missed Nh`。監視の 2 job は §3 の見張りが受け持つ。他の job は登録の時に `JOB_PERIOD_HOURS` へ足す |
| 定義があるのに解除された | `registered_not_loaded`（未登録の job は異常にしない） |
| `--webhook` の欠け | host-health の job の欠けは watchdog（`monitor_webhook`）が、watchdog の job の欠けは host-health（`monitor_args`）が待たずに知らせる。`--heartbeat`・`--github-owner` の欠けも `monitor_args` |

監視の定義の変化（`monitor_config_changed`）は host-health・watchdog・バックアップの plist、バックアップの除外の条件（deny）、`repos.conf`、Human Gate の policy 2 つを見る。

### 見張りが黙って外れないように（2026-11-07 追加）

| 見えなくなる場面 | 何が知らせるか |
|---|---|
| `--no-guard` で見張りの項目ごと消える | watchdog の `monitor_webhook=no_guard`。ファイルの定義と launchd の今の引数の両方を見る |
| 固定ファイルが読めず変化を検知できない | `monitor_fingerprint` が unknown になり、24 時間で `monitor_blind` |
| `state.json` の消失・破損で基準が初期化される | 記録があるのに state が無い回に `monitor_state_reset` を 1 回（送れなければ次の回へ持ち越す） |
| GitHub の token が Keychain から消える | 動いていた見張りなら `github_api=token_missing`（知らせ済みの `github:` の項目も残す） |
| バックアップの対象のフォルダの欠け | 受領票の `sources_missing` から `backup_sources`（WARN は 24 時間続いたら 1 回） |
| `jsonl` だけ書けない | state の前に書くので 1 回分の失敗に数え、3 回で `DISABLED` |
| `PAUSE`・通知の印の時刻が未来 | 期限の幅を超えた未来は効かせない。印の未来の時刻では黙らない |

`monitor_args`・`agent_scope` は行き来しても 24 時間に 3 通まで（新しいコードは上限を待たない。超えた分は続いていれば明けた回に知らせる）。出来事の上限は §2。

### 3-1. 外部の死活監視（H6）

`--heartbeat` の時、host-health の 1 回分が記録を残した後に、VPS の受け側へ時刻と署名だけを送る（`scripts/lib/heartbeat.mjs`）。受け側は最後の信号から 70 分途絶えたら Discord へ 1 回（信号は 30 分ごとなので、1 回の抜けでは鳴らない）、戻ったら 1 回知らせる（原因は断定しない。24 時間に 2 回途絶えたら「反復」を 1 通）。受け側と導入は `deploy/vps-heartbeat/README.md`（導入は Human）。

- Keychain の `heartbeat-url`・`heartbeat-token` が無い間は何も送らない
- 送れない状態が 6 時間続けば `heartbeat` の WARN（§2 のとおり続いた時に 1 回）。送った先で署名が合わない時も同じ
- `DISABLED` の間は送らないので、途絶として届く
- VPS・Cloudflare・Discord の停止は知らせられない

防御の範囲と限界の監査の結果は private の Vault（MA-22）に置く。

## 4. GitHub

`--github-owner <owner> --github-credential credential:E-NEXUS/edl/github-monitor-token` の時だけ、GET で 6 repo を読む（1 回に repo ごと 4 通信まで。relay の repo は受領の一覧のために 1 通信増える）。
**無人 job は専用の読み取り token だけを使う**（2026-11-05 Human 決定）。`gh` のログインや classic token は読み書きの範囲が広いので受け取らない（`github_pat_` 以外は `auth_failed`）。Keychain に token が無い間は項目も通信も無い。

| 項目 | 水準 |
|---|---|
| private → public | CRIT（出来事） |
| public → private・既定 branch の変化 | WARN（出来事） |
| 既定 branch の先頭 commit の Actions か commit status の失敗 | WARN（§2 のとおり 24 時間続けば 1 回） |
| Actions の run が 6 時間終わらない | WARN（`ci_stuck`） |
| archived | WARN |
| disabled・見えない repo | CRIT（CI の失敗が続く repo でも悪化としてすぐ知らせる） |
| 通信の失敗 | 6 時間までは unknown（悪化も回復も作らない）。続けば `github_api=unreachable` の WARN |
| token が使えない（失効・権限不足） | `github_api=auth_failed` の WARN（監視自体の失敗） |
| token の期限まで 14 日未満 | `github_api=token_expiring` の WARN |
| Mac の HEAD と GitHub の差 | 別の PC の push で Mac が遅れるのは普通なので値だけ。7 日続けば WARN（未 push は除く） |
| relay の受領待ち | `relay_unacked`。送った封筒のうち Vault の受領（`acks` branch のファイル名。中身は読まない）がまだの件数。`held`・`rejected` も受領に数えるので、中身は `status --fetch` で見る。取り込みは Windows のまとめ作業なので記録だけで知らせない |

未 commit・未 push は `repo:<name>`（runtime-guard・24 時間の猶予）が受け持つ。Trading Lab の repo は見ない。Vault の repo は token の範囲に入れない（中身の読み取りを渡さない）ので、公開範囲もここでは見ない。

### token の発行（Human の操作）

1. GitHub の Settings → Developer settings → Fine-grained tokens → Generate new token。Resource owner は自分、Repository access は **Only select repositories で管理対象の 6 repo だけ**、期限は 1 年以内
2. Repository permissions は **Metadata・Contents・Actions・Commit statuses をすべて Read-only**。それ以外は No access（Contents の読み取りは既定 branch の先頭を見るため）
3. Mac の Terminal で `bash deploy/macos/connect-github-monitor.sh <owner>`。token を Keychain へ入れて検収する（書き込みができる token・6 repo より広い token は不合格で、Keychain から消える）
4. 合格すれば次の回から動く。job の定義は登録済みなので launchd の操作は要らない。戻す時は `bash deploy/macos/keychain-edl.sh delete github-monitor-token`

## 5. バックアップ

GitHub の専用 Private repo へ暗号化して毎日 1 回置く（2026-11-05 Human 決定・H5）。対象は Mac に保全先の無い Mac Runtime の記録だけで、**Time Machine の代わりではない**（Mac 全体は戻らない）。

| 道具 | 役割 |
|---|---|
| `scripts/backup-inventory.mjs` | 棚卸し（結果は標準出力だけ。**公開の場へ貼らない**） |
| `scripts/lib/backup-plan.mjs` | 選別（allowlist）・世代 |
| `scripts/lib/backup-archive.mjs` | AES-256-GCM（改ざん検知）・鍵は passphrase から scrypt・パス名も暗号の中・gzip |
| `scripts/backup-drill.mjs` | 合成データの予行 |
| `scripts/backup-run.mjs` | `plan`・`check`・`run`・`verify`・`attest-key`・`restore` |
| `deploy/macos/connect-backup.sh` | Human の接続（鍵・token・初回・job の登録） |

- 対象：`~/e-nexus-runtime` の作業メモ・rules・`mac-runtime-state`（Hermes の bundle を除く）・Claude の memory・relay の設定と未送信・host-health の記録
- 除外：コード（GitHub にある）・Keychain の Secret（再発行で戻す）・再生成できるもの・Hermes の home（読めない）・文字列でないファイル・Secret の形か名前のファイル・Trading Lab の名前か言及のあるファイル・deny のパターンにあたるファイル（`--deny-file`。公開 repo に置けない識別子を含むのでローカルのファイル。無いか 5 行未満なら動かない。判定は Hermes の写しと同じ本物の `grep`）
- 検査した本文そのものをアーカイブへ入れる（検査の後の差し替えは入らない）。平文の写しは `~/.enexus/backup/work`（0700）で、1 時間より古い残骸を毎回の始めに消す
- host-health の記録は新しい 2 か月分だけ。全体 16 MiB を超えたら止まる

### 本番データを送る条件（1 つでも欠ければ送らない・毎回確かめる）

1. 保存先が Private（API の `private`・`visibility`）
2. token が fine-grained で、見える private repo が保存先だけ（`/user/repos` の一覧と、管理対象の repo の個別の確認の両方。確かめられなければ送らない）・公開の repo へ書けない（失敗する要求で確かめる）・Administration の権限が無い
3. passphrase が Keychain にあり、**Mac の外の控えから打ち直して一致した記録がある**（passphrase を変えると無効）
4. 合成データの予行が通り、今回のアーカイブを手元で復元して全ファイルが一致する

公開の repo へ書けないことの確かめ（`check`・`run`）：管理対象の公開 repo へ、必ず失敗する要求（不正な ref とゼロの sha）を 1 回出す。書ける token でも 422 で、何も作られない。token の範囲の外なら 403／404。
- 残している理由：読み取りでは代わりにならない。`GET /repos/...` の `permissions` は token でなく人の権限を返す（2026-11-07 に実測）。fine-grained の権限は値を変えずに編集できるので、最初の 1 回だけの確認でも足りない
- 出さない回：`verify` は送らないので出さない（定期の 30 日ごとの検証も含む）。送る経路は `run` だけ
- レート制限の 403・429 は答えとして数えない（`scope_unverified` で送らない。Administration の確かめも同じ）。要求の形は test で固定している

### 世代と容量

毎日 1 回。新しい 14 世代と月ごとの最新 12 か月分を repo の先頭に残す（1 回に 5 件まで消す）。消したものも Git の履歴に残る。1 アーカイブ 20 MiB まで・repo 全体 800 MiB を超えたら止めて知らせる（整理は Human）。

**定期の時刻**：plist の `StartCalendarInterval` は launchd が持つ時刻帯で読まれる。Mac の起動の後に時刻帯を変えると、次の起動まで前の時刻帯のまま動く（時と分の指定だけが影響を受け、毎時の job はずれない）。実際の時刻は受領票の `finished_at` で確かめる。見張りは経過時間で判定するので、時刻がずれても検知は変わらない。

### 監視

- 送った後に GitHub から読み直し、hash の一致と復号を確かめてから受領票（`~/.enexus/backup/last.json`・`runtime-backup-receipt/v1`）に書く（Vault の「同期＝バックアップではない」：届いたことを別の経路で実証する）
- 保存済みの検証（`verify`）：保存済みの全世代（上限 30。保持は最大 26）を読み直し、一覧の blob の hash・復号・全ファイルの hash・1 byte の改ざんと別の passphrase が拒まれること・除外の方針（Secret の形・Trading Lab の言及・deny）を確かめる。平文はメモリの上だけで、方針の grep の間だけ `work`（0700）に置く。結果は件数だけ。定期の回の中で 30 日に 1 回動き、保存物の異常は今回の回を成功のまま `backup_history` の WARN にする（45 日より古くなっても WARN）。Keychain・通信の失敗は受領票を変えない。除外の方針を強めた時は、古い世代が世代の整理で消えるまで `history_failed` が続くことがある（中身の判断は Human）。保存物の長い行も窓に分けて全部を検査する（選別の時は長い行のファイルを `long_line` として入れない）
- 選別の安全：対象のフォルダそのものが symlink なら丸ごと入れず（`source_symlink`）、中の symlink はたどらず数える（`symlink`）。開く前に realpath が対象の中かを確かめ、開いた後に同じファイル（dev・ino）かを確かめる（途中のフォルダの差し替えで外を読まない＝`outside_source`）。`source_symlink`・`outside_source` は受領票の `sources_missing` に入り `backup_sources` の WARN になる。Secret・Trading Lab・deny・名前の判定は、見えない文字（ゼロ幅・BOM・方向の制御など）を除いた形でも行う。選別と検証は全体で 90 秒の時間切れ（超えたら `scan_timeout` で失敗＝送らない・違反なしと言わない）
- token の期限：応答の header を受領票の `token_expires_at` へ残し、14 日未満で `credential_backup_token` の WARN（切れたら CRIT）
- host-health の `backup_archive`：受領票が無ければ `not_configured`（異常にしない）。ただし job の plist があるのに受領票が無ければ `receipt_missing` の WARN（消えた受領票で見張りから黙って外れない。初回の回の前も WARN）。2 回続けて失敗で CRIT（Discord へ 1 回。正常時は送らない）。3 日で WARN・7 日で CRIT。**復元の確認が無いか 35 日より古ければ WARN**

### 接続（Human の操作）

1. GitHub で Private repo を作る（`gh repo create` も可。Human-only）
2. fine-grained PAT：Only select repositories で**その repo だけ**、Repository permissions は **Contents を Read and write**（Metadata は Read-only で自動）。期限は 1 年以内
3. passphrase を 20 文字以上で決め、**Mac の外（パスワード管理か紙）に控える**
4. Mac の Terminal で `bash deploy/macos/connect-backup.sh <owner> <repo> <deny-file の絶対パス>`。passphrase・控えからの打ち直し・token の順に聞き、条件を確かめ、初回を送り、job を登録する

### 復元（Mac を失った時）

どの PC でも：① decision-layer を clone ② Private repo の `archives/` から最新を取る ③ `IFS= read -r -s P; printf '%s\n' "$P" | node scripts/backup-run.mjs restore --archive <file> --target <空のフォルダ>`（標準入力に passphrase。Keychain は使わない）。Keychain の Secret は再発行する。

## 6. Hermes へ渡す状態の要約（A2・2026-11-05 Human 承認）

`runtime-status-summary/v1`。host-health の 1 回分の最後に `/Users/Shared/e-nexus-hermes/status/runtime-status.json` を置き換える（`--hermes-user` の時だけ・AI／API なし）。Hermes の OS 権限・toolsets・Human Gate は変えない：読めるのは既存の group（`e-nexus-hermes-read`）で、ファイルは 0640、フォルダは 0750。

- フォルダは host-health が作らない。無ければ何もしない（`status_summary=not_configured`）。**戻す時はフォルダを消すだけ**
- 書けない・フォルダが他人のもの・symlink は `status_summary` の WARN（24 時間続けば 1 回。監視の本体は止めない）
- 監視が止まると更新されないので、Hermes は `generated_at` を見て、古い要約を信じない

渡す：監視の動作（running／paused／stale／disabled）・全体の水準・群ごとの水準と件数（host・hermes・backup・jobs・repos・github）・host／hermes／backup の項目 id と水準。

渡さない：値・パス・hash・pid・回線名・repo 名、それと**見張りの項目**（隔離・固定ファイルの変化・常駐の増減・監視の定義・user 範囲）。見張られる側に検知の中身を渡さないため。allowlist なので、将来足した項目は既定で渡らない。

監視が動いていない時（stale・paused・disabled）の `overall` と各群は `unknown`（古い「正常」を出さない）。項目の無い群も `unknown`。水準は通知の状態ではなく今の観測（`observed`）から取る（送れていない異常を ok と言わない）。

### 6-1. 整理済みの要約（runtime-brief/v1・2026-11-05 Batch B）

同じフォルダの `runtime-brief.json`。Hermes は terminal を持たない（`disabled_toolsets`）ので、読むだけで Human へ答えられる形にしてから渡す。読み方は同じフォルダの `README.txt`（固定の文）。

| 区分 | 渡す |
|---|---|
| 全体 | 監視の動作・全体の水準・要確認の件数と担当の内訳・`valid_until`（生成から 90 分。過ぎたら信じない） |
| GitHub | repo の数・要確認の数・CI の失敗の数・token の残り日数 |
| バックアップ | 最後の成功と復元の確認の日数・失敗中か・古い世代の検証・token の残り日数 |
| その他 | 生存信号のコード・通知の Webhook のコード・relay の未送信と Vault の受領待ちの件数 |
| 続く異常 | `open_items`：項目 id（repo・job・GitHub は群）・水準・日数・担当・原因の候補と次の一手（`lib/ops-classify.mjs` の固定の文） |

**担当の分類**（`ops-classify.mjs`。承認の代わりではない）：`auto`＝監視が再試行や回復を待つ／`ai`＝Claude Code が調べて直せる／`human`＝認証・課金・VPS・Mac の設定・Hermes の権限など Human の操作か判断が要る。分類の無い項目は `human` へ倒す。

**入力境界**（`boundaryViolations`）：書く前に鍵と文字列を allowlist で検査する（固定の語・固定の文・時刻だけ・整数だけ）。別にパス・IP・メール・Secret の形・Trading Lab の語を全文で見る。1 つでも外れれば何も書かず `status_summary=boundary_blocked` の WARN。古いファイルは `valid_until` で切れる。読む側も同じ検査と期限を確かめる（`readBrief`）。

見張りの項目（隔離・固定ファイル・常駐・監視の定義・user 範囲）は §6 と同じく渡さない。

**読む側の検査**（`readBrief`）：形（入力境界）に加えて、中身の矛盾（`briefInconsistencies`：件数と `open_items` が合わない・異常があるのに `overall` が低い・有効期限が 90 分を超える）と未来の時刻（5 分を超える）を信じない。`runtime-ops brief` は `要約を信じられない（理由）` と答える。

### 6-2. Hermes の実読み取りの検証（2026-11-07）

実際の API を使う検証は `deploy/macos/hermes-read-check.sh`。**Human が 1 回だけ実行する**（`sudo` のパスワードが要る。Claude Code は `hermes` として動けず、`.env` も読まない）。

```
sh deploy/macos/hermes-read-check.sh
```

- `hermes -z`（one-shot）を 1 回。道具は `file` だけ、90 秒で強制終了、環境は LaunchDaemon の plist と同じ。Hermes の設定・権限は変えない。`file` には書き込みの道具も入るので、書ける場所は `HERMES_WRITE_SAFE_ROOT` の中だけ（読むだけは問いの文の指示）
- 始めない時：メモリ逼迫・常駐が見えない・hermes の RSS の合計が 2 GiB 以上（常駐の wrapper は 3 GiB で hermes の process を全部止めるので、2 つ目の process の分の余裕を見る）・要約の書き換えの前後（:18〜:22・:48〜:52）。3 ファイルが読めること・usage を置けることは課金の前に hermes の権限で確かめる
- 読む物：`README.txt`・実物の `runtime-brief.json`・合成の `fixture.json`（human・ai・auto が 1 件ずつ。実物は平常なら異常 0 件なので、見分ける力はこれで試す。`status` の外に置き、終わったら消す）
- **API の回数**：Hermes がファイルを読むには、読む指示の応答と答えで Messages API の要求が 2 回以上になる。`-z` に回数の上限は無い（`--max-turns` は `chat` だけで、`chat` に `--usage-file` は無い）ので、時間の上限で止める。一時的な障害なら Hermes が再試行する（`agent.api_max_retries`・`auto_recovery_cycles` は既定のまま）。回数は結果の `api_calls`
- 採点は決定的（`scripts/lib/hermes-read-check.mjs`）：実物の値・合成の分類・書かれていないことを補っていないか・Secret の形・model と provider・回数（補助の呼び出しを含む）。読んでいる間に要約が書き換わって実物の値だけが違う時は `inconclusive`。結果は証跡の `result.json`、一覧は `runtime-ops overview`
- 証跡は `mac-runtime-state/hermes/checks/read-check` の 1 か所で、2 回目を拒む。もう 1 回は Human の判断
- **計上先はここでは決めない**。鍵の値を読まずに確かめるため、結果の時刻・model・トークン数を Console の Usage の鍵ごとの表示と Human が突き合わせる。Usage の反映には遅れがあり、直後の 0 は失敗の証拠ではない

## 7. 役割の分担

| 部品 | 担当 | 持たないもの |
|---|---|---|
| host-health | 決定的な監視・通知 | 修復・AI・承認 |
| Hermes | 24 時間の依頼者・要約者 | 権限の付与・承認・Mac の操作・監視の設定 |
| Claude Code | 開発・修正・調査（Max の範囲） | 監視の代行・常駐 |
| P-Stack | 開発の手順と役割のモデル割り当て | 実行時の判定 |
| Decision Layer | 判定（rules → Jev → Human）。**承認はしない** | 実行 |
| Jev | Decision Layer の Adapter の 1 つ（低コストの判定） | 本体の型・各アプリからの直接の呼び出し |
| REA | 解析（local 範囲の 1 フォルダ） | user 範囲の登録・動く process への接続 |
| Product Hub | 表示と資産の台帳 | 判定・監視 |

### 連携の向き

```
host-health ──記録──▶ data/host-health/（state.json・YYYY-MM.jsonl）
     │                    └─(§6)─▶ 要約ファイル ─読むだけ─▶ Hermes
     └──重大と続く異常だけ──▶ Discord（Human）
Claude Code ──作業の記録──▶ devlog relay ──▶ Vault（Windows）
App・Agent ──CLI／SDK／Gateway──▶ Decision Layer ──▶ Jev（Adapter）
```

- 監視から Hermes・Decision Layer へ自動で「判断」を流さない。異常への対応は Human が決める
- Hermes が判定を求める時は Gateway の契約だけを使う（Jev・core を直接呼ばない）。接続の開始は Human の判断
- 使用量：Claude Code（Max）と Hermes（Anthropic API）は別の財布。監視は どちらも使わない

## 8. Grok Bot（将来・未契約）

未契約なので**作らない・接続しない**。足す時の入口だけ決めておく。

- 読むもの：`externalView`（`runtime-brief-external/v1`＝監視の動作・全体の水準・件数と時刻だけ）。文・日数・項目 id は渡さない。形は `node scripts/runtime-ops.mjs brief --external` で確かめられる。渡すには承認が要る（Hermes とは別の読み手なので、読み手ごとに判断する）
- 知らせるもの：既存の webhook の契約（`credential:E-NEXUS/edl/<name>`）。Hermes の差し替えなしに足す
- 持たないもの：Mac の操作・監視の設定・承認・Vault 全体・Trading Lab の情報・Secret
- 外部 API への送信になるので、送る項目と保持の条件を契約の前に確かめる。契約・鍵の発行・接続は Human

## 9. Hermes と Decision Layer・JEV・Human Gate の接続仕様

**今は接続しない**（Hermes の権限・toolsets は変えない。開始は Human の判断）。つなぐ時の形だけ決めておく。

```
Human ──質問──▶ Hermes ──読むだけ──▶ runtime-brief.json
                  │（将来）判定が要る時だけ
                  ▼
        Common Decision Gateway（HTTP loopback か MCP）──▶ Decision Layer ──▶ Rules → JEV（Adapter）→ Human Gate
                  ▼
        結果は Hermes が Human へ伝えるだけ。実行しない
```

| 項目 | 決め |
|---|---|
| 呼び出し | Gateway の Contract v1 だけ。`application_id=hermes`。JEV・core を直接呼ばない |
| 入力 | `decision_type` ごとの schema に入る ID と固定のコードだけ。Secret・パス・プロンプト全文を入れない（`docs/gateway.md` §2） |
| 結果の扱い | `human-required`・`deny` はそのまま Human へ伝える。Gateway が返せない時も同じで、fail-open はない |
| 承認 | Decision Layer も Hermes も承認しない。`policies/safety/human-only.json` の範囲は Human だけ |
| 監視との関係 | 監視から自動で判定を流さない（§7）。`open_items` の `class` は表示の分類で、Decision Layer の判定ではない |
| 接続に要る変更 | Hermes の `connections` か MCP の有効化＝権限の変更なので Human-only。Gateway の常駐と token も Human-only（`docs/gateway.md`）。Console の計上先の確認が先 |

## 10. 認証情報の期限と更新

値はどこにも書かない。項目は全部 `E-NEXUS/edl/<name>`（Keychain）。Human が Mac の Terminal で実行する（Claude Code の `!` では実行しない）。

| 項目 | 期限の見張り | 更新 |
|---|---|---|
| `github-monitor-token` | 応答の header。14 日未満で `github_api=token_expiring`、30 日未満で `runtime-ops human` | §4 の発行のとおり新しい token を作り `bash deploy/macos/connect-github-monitor.sh <owner>`。合格を確かめてから GitHub で古い token を消す |
| `backup-token` | 受領票の `token_expires_at`。14 日未満で `credential_backup_token`、30 日未満で `runtime-ops human` | §5 の接続の 2 のとおり作り `bash deploy/macos/keychain-edl.sh set backup-token`、`node scripts/backup-run.mjs check …` が `ready` なら古い token を消す |
| `backup-passphrase` | 期限なし | 変えると過去のアーカイブが読めなくなるので、Mac の外の控えと一緒に新旧を残す。変えた後は `connect-backup.sh` の確認をやり直す |
| `heartbeat-token` | 期限なし | 漏えいの疑いがある時だけ。VPS の env を入れ替えて service を再起動（Human）→ `connect-heartbeat.sh`。順番の間は `rejected` で途絶の通知が出ることがある |
| `heartbeat-url` | 期限なし | hostname を変えた時に `connect-heartbeat.sh` |
| `host-health-webhook` | `notify_channel`（1 日 1 回の GET。`ok` 以外の間は毎回） | `bash deploy/macos/connect-discord-alerts.sh` |

会話やログへ出た値は失効させて作り直す。古い値は使い回さない。

## 11. 運用の道具（`scripts/runtime-ops.mjs`）

記録を読むだけで、通信も Keychain も使わない。新しい job・常駐は無い。

| 命令 | 使う場面 |
|---|---|
| `acceptance [--days 7]` | H2〜H6 と観察（H8）の判定（pass／pending／fail）。定期の回の結果を後から確かめる。fail があれば exit 1 |
| `why <項目の id>` | 項目の経過・通知の有無・担当・確かめ方。異常の調査の入口 |
| `human [--ledger <abs>]` | Human が要ることの一覧。台帳（公開 repo に置かない `mac-runtime-state/human-required.json`）＋今の異常＋token の期限。台帳の行に `"done_when": "read_check_pass"` を付けると、Hermes の読み取りの検証が pass の間は出さない（inconclusive・fail・未実施は出す。知らない条件は出す） |
| `brief [--external]` | Hermes が読む要約を読む側の手順で読み、答えの形にする |
| `timeline [--days 7]` | 全項目の変わり目・出来事・通知を時刻の順に。同じ出来事の連続は 1 行。値は通知と同じ関所を通す |
| `overview [--days 7]` | 検収・今の状態・Human が要ること・Hermes の読み取りの検証を 1 画面に。新しい判定は足さない |

観察（H8）の窓は `--days` と別に 8 日分を読み、Hermes の常駐を ok と見た最初の回からの幅が 7 日に届けば判定する。見えなかった回（`hermes_service_unseen`）が 2% を超える間は pending。合格の目安：`hermes_service` の異常なし・`hermes_restarted` なし（Human の操作の分は事実を見て Human が判断する）・`hermes_files_changed` なし・RSS のピーク 3 GiB 未満・`memory_pressure` と `swap_used_gib` の警告なし・記録の空白なし（Mac の再起動の分は除く）。1 つでも外れれば fail で、`facts` にどれかが出る。

バックアップの検証は `backup-run.mjs verify`、監視の記録の要約は `host-health.mjs --report`。
