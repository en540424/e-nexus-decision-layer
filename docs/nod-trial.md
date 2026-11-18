# Nod の試験導入（Mac の公式デスクトップ版・2026-11-18）

**状態（2026-11-18）：Mac に公式の v0.8.4 を入れた（`/Applications/Nod.app`・署名と公証と build の証明を確かめた）。まだ一度も起動していない。**
初回の setup・ChatGPT のサインイン・プライバシーの設定は Human が画面で行う（§3）。Nod は**正式採用ではない**。本番の n8n・Dropbox・Grok へはつながない。
起動・完全終了・計測の道具は `scripts/nod-desktop.mjs`、見張りは host-health の `nod_desktop`（§4）。仕事を Task Hub から Nod へ渡す公式の手段は v0.8.4 に無い（§5）。

Nod は n8n Labs が公開した研究プレビューのオープンソースの AI agent（Apache-2.0）。公式：<https://nod.n8n.io/>・<https://nod.n8n.io/docs/>・<https://github.com/n8n-io/nod>。
以下の事実は tag `nod-v0.8.4`（source `a461094`・2026-11-17 公開）の docs と source を 2026-11-18 に読んだもの。**毎日のように新しい版が出る**（0.6.0〜0.8.4 が 9 日間）ので、版が上がったら §1〜§3 を読み直す。

## 1. 入れた物と確かめたこと

| 項目 | 値 |
|---|---|
| 入れた物 | `nod-arm64.dmg`（338,646,260 byte）の中の `Nod.app` を `/Applications` へ写しただけ（起動していない） |
| sha256 | `9bf70f9c3c8686fb5a6397497005c255bffbfdf4ad01acf5cc294ccb4acb4613`（release の `SHA256SUMS`・`release.json` と一致） |
| 署名 | Developer ID Application: n8n GmbH（Team `GRHFXT3RL9`）・`codesign --verify --deep --strict` 合格（写した後も） |
| 公証 | `spctl` が `Notarized Developer ID` で accepted・`stapler validate` 合格（dmg と app） |
| build の証明 | `gh attestation verify`：n8n-io/nod の `.github/workflows/desktop-release.yml` が作った物 |
| 中身 | LaunchAgent・LoginItem・system extension・kext は bundle に無い。sudo は要らない（公式の手順も「sudo なしで」） |
| 必要な OS | macOS 14 以上（この Mac は満たす） |

確かめ直し：`node scripts/nod-desktop.mjs status`（版・署名の Team・動いているか・更新の job〈ShipIt〉の有無・データの場所が在るか）。

## 2. 起動すると何が起きるか（source で確かめた）

- **初回の setup の画面を開いた時点で**、Human が何かを選ぶ前に runtime の pack（約 1.7 GB・GitHub の release から）の取得と VM の起動が始まる（`desktop/ui/setup.tsx` の `warmup`）。「使用状況の共有」の既定は **ON**（同じ所）
- VM：Lima＋Apple Virtualization.framework（Ubuntu）。大きさは memory＝物理メモリの半分を 3〜6 GiB に・cpus＝2〜4・disk 24 GiB（使った分だけ増える）＝**この Mac では 6 GiB・4 CPU**。Docker は VM の中だけ（PostgreSQL・workspace・browser の container）
- データ：`~/Library/Application Support/nod/`（profile・runtime の pack）・VM は `~/.nod-desktop/<profile>`（場所は変えられない＝公式の issue #969）
- setup が終わると「**ログイン時に開く」が自動で ON**。画面を閉じても menu bar に残り、chat・schedule・背景の確認が動き続ける
- 背景の「準備」（Gmail は 15 分ごと・Calendar は 30 分ごと・既定の上限 月 $5）は、それらをつないだ時だけ意味を持つ。**つながない**
- 更新の確認：起動の時・6 時間ごと・復帰の後。週の最初の版は runtime を作り直す＝更新で約 1.7 GB を取りうる
- 仕事の間は Mac の idle sleep を止める
- 待ち受け：engine は 127.0.0.1 の空いた port（起動ごとの token・Nod の画面だけが使う）・PostgreSQL は 127.0.0.1 の空いた port から VM の中へ・ChatGPT のサインインの間だけ 1455

→ **初回の起動は Human が居る時に Human が行う**（取得と VM の起動が無人で始まり、プライバシーの設定と setup は画面の操作だけ＝この Mac では画面操作の自動化を使わない）。

## 3. Human の初回の手順（設定の目標）

1. Mac の Terminal で `cd ~/e-nexus-runtime/e-nexus-decision-layer && node scripts/nod-desktop.mjs session`
   - 関所（§4）を通れば、送信を切る環境変数（解析 `NOD_ANALYTICS_ENABLED=false`・不具合の報告 `NOD_FEEDBACK_URL=`・onboarding の email の登録 `NOD_ONBOARDING_EMAIL_URL=`）つきで Nod を起動する（Nod が自分で再起動した時は効かない＝画面でも OFF にする）
   - 前・最中・後のメモリと Nod の process・データの大きさを `~/e-nexus-runtime/nod-lab/measurements/` に残す。VM の memory は Nod の process の RSS に入らない（Virtualization.framework の別の process）＝前と最中の「使える見込み」の差で見る
   - 途中で止めても（Ctrl-C・入力の終わり・記録の失敗）道具は公式の Quit まで行く。それでも残れば `node scripts/nod-desktop.mjs stop`
2. Nod の画面で（**順番どおり**）：
   - welcome の「使用状況の共有」を **OFF** にしてから進む。email の欄は空のまま
   - **Settings → Privacy & data**：Share usage data **OFF**・Share conversation traces **OFF**（既定 OFF を確かめる）
   - **Settings → General**：Open at login **OFF**
   - モデル：**Sign in with ChatGPT**（ChatGPT Plus。OpenAI の画面で Human がサインイン）。**API key は入れない**（入れた時だけ従量課金になる）。Anthropic は API key だけの対応なので使わない
   - 外部の app（Gmail・Calendar・Dropbox・1Password など）・Local files・channel（Telegram・WhatsApp）・schedule は**つながない・作らない**
   - Keychain の「nod Safe Storage」の確認が出たら許可してよい（Nod 自身の暗号の鍵の置き場所。他の app の資格情報は Nod に渡さない）
3. 安全な試験（課金なし・ChatGPT Plus の枠）：「こんにちは、あなたが今使えるモデルと、外部の app に何もつながっていないことを教えて」程度の 1 往復 → ChatGPT の Settings → Usage で使った量を見る
4. Terminal に戻って Enter → 道具が公式の Quit で完全終了し、app と VM が消えたかを確かめ、1 分後にもう一度計測して差を出す
5. 結果（道具の最後の `summary` の表示）を Claude Code へ。`vm_left`・`app_still_running` なら Nod を開き直して menu の **Quit Nod**（強制の停止はしない）

## 4. 起動・完全終了・見張り（`scripts/nod-desktop.mjs`・`scripts/lib/nod/desktop.mjs`）

- `status`・`gate`・`measure`・`stop` は Claude Code も使える。`start`・`session` は Terminal の Human だけ（tty でなければ `needs_terminal` で何もしない）
- **起動の前の関所**（`gate`）：使える見込みのメモリ（free＋inactive＋speculative＋purgeable）≥ VM の分＋4 GiB・swap ≤ 1 GiB・メモリの圧迫が normal・空き ≥ 40 GiB。読めない値は止める側。同じ Mac で別の本番の VM が動いているので、余裕が無ければ起動しない。2026-11-18 の計測では通った（値は手元の `nod-lab/measurements/` だけに残す）
- **完全終了**（`stop`）：app の本体が動いている時だけ、`if application id "dev.nod.desktop" is running then … quit`（`is running` は起動しない＝止まっている app を起こさない）＝Nod の `before-quit` が VM を `limactl stop` で止めて Stopped を待つ公式の経路。最大 150 秒、app の本体と Nod の runtime の process が消えるのを待つ（quit の返事が失敗・時間切れでも待つ）。残れば `app_still_running`（「Try again／Quit anyway」の画面か作業中の確認）・`quit_unconfirmed`（返事が無く app も残った＝「自動化」の許可の確認が出ていないか見る）・`vm_left`。**kill・pkill・limactl を直接は実行しない**（道具の許可の一覧に無い）。Human が使っている Nod を AI は止めない（見張りの知らせは Human 向け）
- **見張り**（host-health の `nod_desktop`・30 分ごと・Nod が入っている時だけ・15 秒の予算）：`not_running`／`running`（ok）・`running_long`（4 時間以上）・`vm_left`（app は終わったのに Nod の runtime が残った）・`check_failed`（warn は 2 回分続いたら 1 通・値が変われば知らせ直す＝4 時間の知らせの後に VM が残っても届く）。照合は `pgrep -f` の行の頭に固定した 2 つの形（app の本体 `/Applications/Nod.app/Contents/MacOS/nod` と Nod のデータの場所の中の実行 file）だけ＝他の process の一覧は取らない。helper・更新の ShipIt は本体に数えない
- VM そのもの（Virtualization.framework の XPC の process）は名前で Nod と分けられないので数えない（hostagent が残っていれば VM が残っている）。Lima の ssh の転送の process も数えない
- 未確認：AppleScript の quit に macOS の「自動化」の許可の確認が出るか（出たら Human が許可）。Nod の更新が途中で失敗すると ShipIt の job が残り「Nod is damaged」になる既知の不具合（公式の対処は `launchctl bootout` だが、Human の判断）

## 5. Task Hub・Hermes・Grok から Nod を使えるか

| 求めること | v0.8.4 の公式 | ここでの扱い |
|---|---|---|
| 外から仕事を登録・task id・進捗・成功／失敗／承認待ち・結果の取得 | **無い**（CLI・公開の HTTP／WebSocket・仕事を受ける MCP は無い。local の engine の API は起動ごとの token で Nod の画面だけのもの＝内部） | **技術的に未対応**。内部の API・DB を使わない |
| `nod://` の URL | Nod の画面の頁を開くだけ（仕事は渡せない） | 使わない |
| 外からの入力 | Telegram・WhatsApp の channel（Nod から外への接続） | 外部の account の新規の認証・業務の文が第三者の messaging を通る＝**Human の判断** |
| 起動・完全終了・状態の監視 | app の起動と公式の Quit | **実装済み**（§4）。Task Hub の intent にはまだしない（採用前） |
| GUI の login session | 要る（再起動の後は Human が login して Nod を開くまで何も動かない） | 無人の常駐の役には向かない |

**今の結論**：Grok → Task Hub → Nod の自動の受け渡しは、Nod 側に公式の受け口ができるまで作らない。今できる形は「Task Hub が依頼と承認を記録 → Human が Mac で `session` を起動 → Human が Nod に頼む → Human が結果を `note.record` で Task Hub へ」＝Human の手が 2 回入る。
将来の候補（どれも Human の判断が先）：① Nod の公式の受け口（CLI・公開の API）が出たら、Task Hub の handler（`nod.task`・human_required・1 回だけ渡す・状態は通常のプログラムで監視・終わったら `stop`）を足す ② self-host の Nod server（`NOD_AUTH_TOKEN`）の API が公開の契約になったら同じ ③ Telegram の channel（外部の account と送り先の業務データの扱いを決めてから）。
Hermes は Nod の作業の途中に入らない（Nod 自身の AI は ChatGPT Plus＝Hermes の従量課金と分ける）。承認は Nod 独自の確認（model の判断＝安全の filter ではないと公式が書く）に閉じず、本番に触る物は Task Hub・Decision Layer の承認を先に通す。

## 6. Nod と n8n

- 公式の接続：n8n の **instance-level MCP server**（URL＋n8n の OAuth の同意か、n8n の Settings → Instance-level MCP の access token）。読む（node・実行の記録）・作る・直す・試す（外へ出る step は sample に置き換え）・公開（「publish」と言った時だけ）。Nod は n8n の資格情報を作らない・読まない。n8n の操作ごとに Nod の確認が入る
- **この Mac から本番の n8n（電話 AI）へは何もしていない**：Mac に n8n の URL・token は無く、本番の n8n は VPS の別の基盤。本番への接続（読むだけでも）・Webhook・認証・有効化／無効化の変更は Human の承認
- 模擬の n8n は公式に無い（local の n8n は使える）。検証は ① Human の承認で検証用の n8n を手元に立てる（公式の Docker か npm。この Mac には Docker が無い）→ ② 本番の電話 AI の workflow を **書き出した JSON の写し**（資格情報を含まない）を検証用へ取り込む → ③ Nod に「構造の説明・エラーの記録の解析・直す案・複製の作成・複製での試験」を頼む、の順。今回は ① が未承認のため未実施
- 定型の処理を n8n でやるか Claude Code の code でやるか：**既にある Task Hub の仕事（受け渡し・承認・監査・Dropbox の読み）は置き換えない**。新しい定型（外部 SaaS の API をつなぐだけ・schedule と通知・形の決まった変換）は n8n の標準の node で作る方が保守が軽い（画面で見える・Nod が直せる）。判断・監査・資格情報の分離が要る物は Task Hub 側

## 7. 費用の比較（実測は無い＝推測を含む）

| 案 | AI の費用 | メモリ | Human の承認 | 向くこと |
|---|---|---|---|---|
| A：Grok → Task Hub → Nod（ChatGPT Plus） | Plus の枠の中（追加の従量なし・枠の上限は未確認） | 起動の間だけ VM 6 GiB＋app | 起動 1 回（今は受け渡しも Human） | n8n の構築・修復・Web の操作 |
| B：A の途中に Hermes | A＋Hermes の従量（Haiku で 1 回 約 2 万 token＝2026-11-18 の実測） | A＋Hermes（常駐 約 0.3 GB） | A＋Hermes の有料の承認 | Nod に渡す前に AI の判断が要る時だけ |
| C：Grok → Task Hub → Hermes だけ | Hermes の従量 | 常駐の分だけ | 有料の実行ごと | 文章の分析・要約・分類 |
| D：Grok → Task Hub → 既存の n8n | n8n の中で使う外部 API の料金だけ（AI を使わなければ 0） | Mac は 0（VPS） | workflow の変更の時 | 決まった連携・schedule・通知 |

既定の順：AI の要らない受け渡し・起動・停止・結果の転送は Task Hub の通常のプログラム（無料）→ 決まった連携は D → AI の作業は A（Plus の枠）→ 判断が要る時だけ C／B。
**2026-11-18 の Nod の追加費用：0 円**（無料の配布物・API key なし・サインイン前）。

## 8. 残る限界・Human の判断

- Nod は研究プレビュー（破壊的な変更あり・公式の backup／restore／downgrade なし）。版を固定できない（更新は app の中）
- Nod の確認は model の判断（公式に「安全の filter ではない」）。業務のデータ・本番の n8n をつなぐ前に Task Hub の承認と分ける
- 台帳（`mac-runtime-state/human-required.json`）：`nod-first-session`（初回の setup とサインイン）・`nod-n8n-sandbox`（検証用の n8n）・`nod-adoption`（採用・受け渡しの方式）
