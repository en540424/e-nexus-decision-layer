# Cursor・Terminal を閉じても続く作業の session（dev-session）

2026-11-23・MA-24。Mac Runtime の作業を、IDE（Cursor）や Terminal の窓に依存せずに続けるための道具。
常駐の process・LaunchAgent・設定の変更は足していない。

## 1. 使い分け

| 作業 | 道具 | Cursor を閉じても | 戻り方 |
|---|---|---|---|
| Claude Code の作業 | **公式の `claude --bg`**（Claude Code 2.1.3xx） | 続く（supervisor が launchd の子） | `claude attach <id>`・`claude logs <id>`・`claude agents` |
| Claude 以外の長い処理（試験・script・集計） | `node scripts/dev-session.mjs start`（/usr/bin/screen を包む） | 続く（screen の server が launchd の子） | `dev-session attach <name>`・`log <name>` |
| 状態の一覧（両方） | `node scripts/dev-session.mjs status` | — | — |

`claude --bg` と同じ物は作らない。dev-session が Claude について持つのは一覧だけで、それも読み取り専用（`claude agents --json --all` のうち、cwd が `~/e-nexus-runtime` の下の background の session だけ）。
同じ OS user の別の業務の session は、一覧に出さず触らない。

## 2. Claude Code の作業を始める（Human か Claude Code）

```sh
cd ~/e-nexus-runtime/e-nexus-decision-layer
claude --bg "docs/task-hub.md の §11 の残件を確かめて、直せる物を直して試験まで"   # id が出る
claude agents                 # 一覧（Needs input＝承認待ち）
claude attach <id>            # 画面へ戻る（Cursor でも Terminal でも SSH でも）
claude logs <id>              # 最近の出力
claude stop <id>              # 止める（会話は残る・claude --resume で再開できる）
```

- 承認の確認（permission prompt）は、離れている間も止まって待つ。`claude agents` に Needs input と出たら、`attach` して答える。承認の仕組みは緩めない。`--dangerously-skip-permissions` と bypass は使わない。
- 入力を待ったまま約 1 時間 attach されないと、Claude Code が session を止める（公式の仕様）。長く離れる時は attach した画面で Ctrl+T（pin）を押す。
- **使わない command**：`claude respawn --all` と `claude daemon stop --any`。どちらも同じ OS user の全部の background の session に効く。respawn は自分の id だけに使う。
- 費用：Max の定額の枠を使う。API の従量課金は使わない（`ANTHROPIC_API_KEY` を入れない）。

## 3. Claude 以外の長い処理

```sh
node scripts/dev-session.mjs start full-test --cwd ~/e-nexus-runtime/e-nexus-decision-layer -- \
  /usr/sbin/taskpolicy -b nice -n 10 node --test "tests/**/*.test.mjs"
node scripts/dev-session.mjs status
node scripts/dev-session.mjs log full-test --lines 30
node scripts/dev-session.mjs attach full-test      # Terminal だけ。離れる時は Ctrl-a d
node scripts/dev-session.mjs stop full-test
node scripts/dev-session.mjs history
```

- **二重に起動しない**：同じ名前の job が動いている間は `already_running` で止まる（exit 1）。同時の start は mkdir の lock で 1 つだけ通る。
- **終了コードと履歴**：runner が `exit.json` と `history.jsonl` に終了コードを残す。同じ名前で次に起動すると、前の回は `archive/` へ移る（消さない）。
- **異常の把握**：終わりの記録が無いまま screen が消えた job は `vanished`。logout・再起動・強制終了のどれか。`stop` で止めた job は `stopped`。
- **メモリ**：常駐しない。screen の server は job の間だけ動き、数 MB。
- 子には `CLAUDECODE`・`CLAUDE_CODE_*`・`VSCODE_*`・`CURSOR_*` を渡さない（入れ子と誤読させない）。`SCREENDIR` は保存先の `.screen/`（0700）に固定する。Terminal と SSH のどちらから attach しても同じ所を見る。
- 保存先：`~/e-nexus-runtime/mac-runtime-state/dev-sessions/`（0700・repo の外）。`EDL_DEV_SESSION_DIR` で変えられる（試験用）。

## 4. 無人で続く条件

| 状態 | screen の job | `claude --bg` |
|---|---|---|
| Cursor を閉じる・Terminal の窓を閉じる | 続く（実測：§6） | 続く（supervisor は launchd の子・実測：§6） |
| 画面のロック | 続く（process は止まらない。この Mac は system の sleep が 0＝眠らない） | 続く |
| system の sleep | この Mac は sleep 0。眠る設定に変えると止まる（電源の設定は共有の資源＝変えない） | 公式：sleep の後も残る |
| logout | 止まる（user の process は全部終わる） | 止まる（公式の文書に記載なし・同じ扱いとみなす） |
| 再起動・停電 | 止まる → `recover` で一覧 | 止まる → 48 時間以内なら `failed` と出る。`claude attach <id>` で会話から再開 |

再起動の後に自動で再実行はしない。再起動の後の自動の再開は、LaunchAgent の追加と、無人の認証での Claude Code の起動を意味する。どちらも Human の承認の範囲なので作らない。

## 5. 再起動・logout の後

```sh
node scripts/dev-session.mjs recover    # 消えた job と、やり直しの command（打つのは人か Claude Code）
node scripts/dev-session.mjs forget <name>   # やり直さないなら記録を archive へ（見張りの warn が消える）
claude agents                           # failed の Claude の session → claude attach <id>
```

host-health の項目 `dev_sessions`：保存先がある時だけ出る。消えた job があれば warn で、2 回続いたら通知する（値は `ok`／`vanished`／`check_failed` だけ）。

## 6. 実測（2026-11-23）

- screen（Apple の 4.00.03）：Cursor の中から、擬似の terminal（`script` の pty）を通して job を始めた。その terminal の process group を SIGHUP → SIGKILL で殺しても、job は続いた（tick が増え続け、終了コード 3 も記録された）。screen の server の PPID は 1。二重の start は `already_running`。強制終了は `vanished`。同じ形の試験は `tests/dev-session-20261123.test.mjs`（実物の screen）。
- `claude --bg`：最小の probe（Haiku・道具なし）で始めると、`claude daemon run --origin transient` が PPID 1・独自の session group で動いた（Cursor の process の木の外）。session がある間は spare の process を含めて約 0.7 GB。stop と rm の後は supervisor も消えた（常駐しない）。
- Cursor を本当に閉じる試験はしていない。同じ Cursor で別の業務の長い作業が動いているため。上の 2 つは、Cursor を閉じた時に起きること（その terminal の pty の終了・process group への SIGHUP）を再現したもの。
- 2026-11-24 の再確認（実機）：Claude Code の Bash から 2 分の dummy の job を start → 始めた shell が終わった後も job は続き、2 分後に終了コード 3 が記録された（screen の server の PPID 1）。同じ名前の 2 回目の start は `already_running`。`reboot-check` は起動から約 20 時間の時点で全項目 ok（再起動そのものの検証はしていない＝§8）。

## 7. 外から見る・操作する（未接続・Human の判断）

- 消えた job は host-health の Discord の通知で知らせる。Grok（EN司令塔）の `status.query` の要約には今は入れていない。`runtime-brief` の NAMED は外へ出す語の allowlist なので、足すかは Human が決める。
- Claude Code の Remote Control（`claude --remote-control`）を使えば、claude.ai や Claude の app から手元の session を操作できる。外への接続（Anthropic の server を通る）が増えるので、使うかは Human が決める。既定は OFF のまま（`remoteControlAtStartup` は設定していない）。

## 8. 再起動の後の復帰の確かめ（`scripts/reboot-check.mjs`）

```sh
node scripts/reboot-check.mjs          # 読むだけ。起動・書き込み・通信はしない
```

- 見る物：Task Hub・host-health・watchdog・バックアップの LaunchAgent（登録と最後の終了コード、各 job が書く記録の新しさ）。Hermes の常駐（system の domain・running か）と、その要約の新しさ。消えた dev-session の job。failed の `claude --bg`。
- 判定：`ok`・`waiting`（起動から次の回の時間がまだ経っていない）・`problem`。起動の前の記録のままの job は、新しさの範囲の中でも ok にしない（`not_run_since_boot`）。
- LaunchAgent は GUI の login の後にしか動かない。login が要るかどうかは、この Mac の設定で決まる。その設定値（自動の login・ディスクの暗号化）は公開 repo に書かない。確かめ方と Human の判断は Vault の MA-22 ランブックの側に置く。
- 再起動そのもの（実機の検証）は Human が保守の窓で行う。同じ Mac で別の本番が動いているため、Claude Code は再起動しない。
- 2026-11-23 の再起動（Human が夜間のソフトウェア更新を指示していた）：起動の 1 分後に GUI の login、host-health が 6 分後に `rebooted` を検知して Discord へ通知、Task Hub・watchdog・バックアップ・Hermes が戻り、約 20 時間後の `reboot-check` は全項目 ok。＝login があれば LaunchAgent の job は自動で戻ることを実機で確かめた（login が無い時の運用は台帳 `reboot-login-recovery`）
- 自動で戻すのは E-NEXUS の job（LaunchAgent・Hermes の LaunchDaemon）だけ。**Trading Lab（実資金）・Parallels は reboot-check の対象にも自動の復旧の対象にも入れない**（LIVE の起動・再アーム・発注・kill switch の解除は人の手順）。dev-session の job も自動では再実行しない（`recover` が一覧を出すだけ）
- FileVault・自動の login の設定値はこの公開 repo に書かない（Vault の MA-22 ランブック）
