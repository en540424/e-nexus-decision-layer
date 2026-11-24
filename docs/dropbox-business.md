# Dropbox の業務の基盤（2026-11-13・MA-24・Human の正式方針）

Dropbox は E-STEP・E-NEXUS の業務資料の**正本**（Vault の Fable 追加レビュー L：Dropbox＝実体・正本、Obsidian＝地図・ルール）。新しい正本・全面の写しは作らない。
Grok Bot の Dropbox 公式連携をフル権限で使う方式は採らない（閲覧と編集の権限を分けられない）。経路は次のとおり：

```
Human → Grok Bot（EN司令塔）→ Task Hub / Decision Layer（認証・権限・承認・監査）→ Mac mini（AI を使わない handler）→ 権限を分けた Dropbox の API
```

この repo は公開なので、**会社のフォルダ名・file 名・中身は書かない**。許可フォルダは Mac の local config（Task Hub の store の `config.json` の `dropbox`）にだけ置く。

## 1. 資格情報で権限を分ける（Human の設定・1 回）

| role | Dropbox の App Console | scope（Permissions） | できること | できないこと |
|---|---|---|---|---|
| read | 新しい app・**Full Dropbox**・名前は例 `EN-Reader` | `files.metadata.read`・`files.content.read` だけ | 一覧・検索・取得（許可フォルダの中だけ＝code で強制） | **どこにも書けない**（資格情報が書く scope を持たない。`dropbox-auth.mjs` が書く scope を持つ token を保存しない） |
| write | 新しい app・**App folder**・名前は例 `EN-AI-Output`（Dropbox の `/アプリ/EN-AI-Output/`） | `files.metadata.read`・`files.content.read`・`files.content.write` | AI の出力（カルテ・見積の AI 作業版・報告・復元の写し）の作成・追記 | **App folder の外を見ることも書くこともできない**（Dropbox が強制）。共有・削除・移動の呼び出しは client に無い |

手順（Human・Mac の Terminal と ブラウザ）：
1. https://www.dropbox.com/developers/apps → Create app → 上の表のとおり 2 つ作る（Scoped access）。各 app の Permissions で scope を選んで Submit
2. `node scripts/dropbox-auth.mjs --role read --app-key <EN-Reader の App key>` → 表示の URL で許可 → コードを貼る（Keychain へ入る・値は出ない）
3. `node scripts/dropbox-auth.mjs --role write --app-key <EN-AI-Output の App key>`（App folder を選んだかを y で確かめる）。**read を先に**：read の資格情報が入っていれば、write の app が App folder の app であること（Dropbox の一番上の項目が書きの token から見えないこと）を自動でも確かめ、Dropbox 全体が見える app なら保存しない（`write_app_not_app_folder`・2026-11-16）
4. 許可フォルダを決める（下の §2・**Human の承認**）→ Claude Code が config に書く

2026-11-16：Human が 1〜3 を済ませた（2 つの app・認証・Keychain）。4 は案の file を作って Human の承認を待っている（§2-1）。

追加の契約・課金は無い（Dropbox の API app は無料）。

## 2. 許可フォルダ（business ごと・Human の承認の後に config へ）

```json
"dropbox": { "businesses": { "e-step": {
  "read_roots": ["/<現場資料のフォルダ>"],
  "schedule_files": ["/<工程表の xlsx>"],
  "estimate_roots": ["/<見積書の原本のフォルダ>"],
  "deny_roots": ["/<読ませないフォルダ>"],
  "deny_names": ["<名前の部品>"],
  "output_root": "/e-step"
} } }
```

- business が無い＝その business の Dropbox は閉じている（`dropbox_business_not_enabled`）。**E-STEP は e-nexus の権限から広げない**（business ごとに別の表・Task Hub の source の businesses とも 2 重）
- 読みは `read_roots`・`estimate_roots` の下と `schedule_files` だけ（大文字小文字は同じに比べる・`..`・空の部分・見えない文字〈零幅・bidi の向き〉は拒否）
- **承認なしの一覧・検索（`dropbox.list`・`dropbox.search`）に出るのは「`read_roots` の中」かつ「`estimate_roots`・`deny_roots` の外」だけ**（2026-11-16）：現場のフォルダの中に見積のフォルダがある並びでも、広い `read_roots` をそのまま書ける（見積のフォルダは名前も出ない・Dropbox が返した結果も 1 件ずつ絞る）
- `deny_roots`（任意）：`read_roots` の中でも読ませない場所（給与・人事・個人）。どの読み方でも拒否。その中に工程表・見積の原本を置く設定は読み込まない
- **名前で読ませない（2026-11-18・`scope.mjs` の `DENY_NAME_TERMS`）**：path のどの部分（フォルダ名・file 名）が、給与・賃金・賞与・源泉徴収・人事・履歴書・雇用契約・作業員名簿・在留カード・免許証・保険証・住民票・年金・マイナンバー・健康診断・通帳・口座・パスワード・secret・秘密鍵（`.pem` など）などの語を含んでも、**どの読み方でも断る**（一覧・検索の結果にも名前を出さない・見積の原本にもしない）。
  きっかけは実の元請のフォルダに作業員名簿・保険証・給与の名前の file が在ったこと（許可フォルダに足すと名前が一覧・検索に出る）。全角半角・大文字小文字・NFD を畳んで比べる。**共通の下限**で config から外せない（広げるだけ＝読める範囲は広がらない）。business ごとの追加は `deny_names`（任意・40 字まで・50 語まで）。
  比べる時は空白類（全角の空白も）・見えない文字（零幅の接合子・異体字選択など）・中黒を取り除く（「履　歴　書」「給‍与」で下限をすり抜けさせない）。語を含むが別の意味の言葉（個人事業・保険証券）は取り除いてから見る。「名簿」は種類を問わず断る（作業員・社員・協力会社の名簿。取引先の一覧も log に出さない決まりに揃える）。`secret` は `secretary` にも当たる（広く断る側の誤り）。
  **この語を探す検索は受けない**（`dropbox_path_not_allowed`）：結果は絞っても「件数・続きがある」の印で、隠した file の在ることが分かるため。`deny_names` は 2 字以上で、畳んで `/` になる語（全角の斜線）・空白だけの語は設定の誤り。
  許可フォルダ・工程表・見積の原本の名前そのものがこの語を含む設定は、下が全部読めなくなるので読み込まない（`dropbox_config_denied_name`・preflight は `config_code` で出す）。「口座」と「講座」・銀行の名前の現場のように、語を含まない名前は通る
- 書きは App folder の `<output_root>/{karte,estimates,reports,restore}/` だけ
- **path は Dropbox の名前のとおりに書く**（§2-1）。断る側（`deny_roots`・一覧に出さない見積のフォルダ）は全角半角を畳んで比べる（広く断る）
- 機密の段階（Vault のレビュー L）：見積・顧客・取引（L2）を AI が読むのは毎回 Human の承認＝`estimate.ai.*` は `human_required`。給与・個人・人事（L3）のフォルダは許可フォルダに入れない

### 2-1. path の書き方と、書く前後の確かめ（2026-11-16・実の Dropbox で分かったこと）

人が画面で読んだ名前と Dropbox の名前は 1 文字ずれることがある。実の接続では、Human が伝えた名前と実の名前が 2 か所で違った（かっこが全角か半角か・名前の中の全角の空白）。Dropbox の決まり：

| ちがい | Dropbox の扱い |
|---|---|
| 大文字と小文字 | 同じ名前 |
| NFC と NFD（macOS から貼った濁点） | 同じ名前（NFD で聞いても見つかる。実の名前はどれも NFC だった） |
| 全角と半角（かっこ・英数字・＆）・名前の中の空白の有無・全角の空白と半角の空白 | **別の名前**（`path/not_found`） |

- config の path は手で打たない：**API が返した名前を写す**。確かめは `node scripts/dropbox-preflight.mjs --config <案の file> --deep --show-paths`（読むだけ・書かない・file を保存しない）
  - 在る・フォルダか file か・工程表は xlsx で上限の内か
  - 無い path は「何番目の部分から無いか」と「全角半角・空白を畳むと同じ名前が在るか」（在れば Dropbox の名前を出す）
  - **工程表と同じ名前の file が別の場所にも在るか**（在れば warning。古い写しを登録していないか人が見る。登録した側より新しい物の数も出す）
  - 書きの app が App folder の app か・`--deep`：工程表が日付で読める形か（sheet の数と期間だけ）
  - 既定の出力は business と項目の番号と code だけ（会社のフォルダ名を log に残さない）。`--show-paths` は手元の画面だけで使う
- 本番の config に書いた後も同じ道具で確かめる（`--config` なし＝本番の config）
- **同じ名前の木が 2 つ在ることがある**（フォルダを写して使い始めた後に、古い側が残る形）。どちらが今の木かは、名前ではなく中身の更新で決める（file の数・更新の時刻・片方にしか無い file）。古い側は登録しない
- **依頼の path は実の名前に直してから読む**（`scripts/lib/dropbox/resolve.mjs`）：Task Hub の受け口は依頼の文字を NFKC に揃える（全角→半角）＝全角を含む名前は、依頼の文字のままでは Dropbox に無い。
  許可フォルダの下かを畳んだ形で探し、許可フォルダの中の一覧から実の名前の子を選んで下りる。**下りる前に毎回、実の名前で読んでよいかを判定する**（読ませない場所の中の一覧は取らない）。
  許可フォルダの外は見ない。Dropbox に聞く path はいつも実の名前の許可フォルダから始まる。結果の path は実の名前
  - ぴったりの名前が先：依頼の文字のままの許可フォルダ・依頼の文字のままの子が在れば、それ（一覧の順・一覧の上限に左右されない）
  - 黙って片方を選ばない（`dropbox_path_ambiguous`）：畳むと同じ名前の許可フォルダが 2 つ（入れ子でない）・畳むと同じ子が 2 つ・一覧が上限（2000 件）で切れていて「他に同じ子が無い」と言えない
  - 見積の原本（毎回 Human が承認）も同じ決まり＝承認した file と別の file を読まない
- 小文字にすると長さが変わる文字（点つきの大文字 I など）を含む path は扱わない（`dropbox_path_invalid`・config なら読み込まない）：JS の小文字と Dropbox の比べ方が同じとは限らない文字で許可フォルダの外を指させない

## 3. 依頼（Task Hub の intent・AI を使わない）

| intent | class | 内容 |
|---|---|---|
| `dropbox.search`・`dropbox.list` | auto | 許可フォルダの中の検索・一覧（名前・path・大きさ・更新時刻。一覧は名前だけ＝path は結果の `path`＋名前）。検索は file の中身にも当たる（返すのは名前と path だけ） |
| `schedule.read` | auto | 工程表を読むだけ（§4-1：日付で抜き出す）。**工程表に書く道は無い**（読みの資格情報・書く handler なし） |
| `schedule.backup`・`schedule.backup.list`・`schedule.restore` | auto | §4 |
| `karte.create`・`karte.get`・`karte.append`・`karte.search`・`karte.report` | auto | §5 |
| `estimate.ai.create`・`estimate.ai.edit` | human_required | §6 |

EN司令塔（grok-commander）へ出すのは Human の承認の後（config の `grok-commander.intents` と VPS の `--intents`）。今は Mac の Human（human-cli）からだけ。
EN司令塔の business は今 e-nexus だけ＝E-STEP の Dropbox を EN司令塔から使うには、intent のほかに**その source の business に e-step を足す**（Mac の config と VPS の `--businesses`）か、E-STEP 用の Bot を別の source にするかを Human が決める。

**結果の大きさ**（2026-11-16）：Task Hub の結果は 16 KiB まで。日本語は 1 文字 3 bytes＝名前の長い一覧・長いカルテ・工程表の行はすぐ越え、越えた結果は runner が想定外の失敗（続けば PAUSE）にしていた。
読む handler は bytes で数えて手前で切る（`truncated: true`。工程表は `next_from` から聞き直す・カルテは `section` を指定する）。それでも越えた結果は想定内の `result_too_large`（依頼 1 つで Task Hub 全体を止めない）。
**書く handler は、書いた後に失敗と言わない**：結果が越えたら小さな値だけ残して成功を返す（`result_trimmed: true`＝やり直しで二重に書かせない）。見積の結果の tab の名前は 40 まで（数は `sheets_count`）。
検索（`dropbox.search`）は 30 件まで：Dropbox が 30 件を返した時は `truncated: true`（もっと在るかもしれない）。無ければ「これで全部」。

## 4. 工程表：読むだけ＋バックアップ（自動は週 1 回・臨時は依頼で）

- 原本は変えない（セル・数式・tab・行列・名前・移動・削除・上書きのどれも、資格情報と handler の両方で道が無い）
- **週 1 回**：既存の 5 分ごとの Task Hub の回の 1 段（`scripts/business-cycle.mjs`）が、前の週の回から 7 日たった business だけ取る（常駐・LaunchAgent は増やさない・AI を呼ばない）
- **臨時**：Grok「工程表をバックアップして」→ `schedule.backup`。結果の `completed: true` は**保存と検証が済んだ時だけ**（受け付けただけの間は Task Hub の state が queued／running）
- 取り方：Dropbox のサーバーの版（同期の途中の file ではなく、確定した rev）を読みの資格情報で取り、Dropbox の `content_hash` と照らす → tmp に書いて fsync → rename → 読み直して sha256 → 世代の index。前の世代と同じ中身なら新しい世代を作らない
- 置き場所：`~/e-nexus-runtime/business-backups/<business>/schedule/<path の hash>/`（Dropbox の同期の外・Mac Runtime の GitHub のバックアップの外・0700）。**10 世代**。空きが少なければ保存しない（`backup_disk_low`）
- 復元：「昨日の工程表を出して」→ `schedule.restore {at}` か `{generation}` → App folder の `restore/<名前>_復元_<世代>.xlsx`（**別の file**・在れば上書きしない）。原本への置き換えは Human
- 二重の保護：Dropbox の版の履歴（プランの保持期間）＋この Mac の 10 世代
- 見張り：host-health の `business_backup`（失敗した file がある・8 日以上成功していない・**工程表は設定済みなのに読みの資格情報が無くて取れていない＝`no_credentials`**〈2026-11-16：前は ok と出た〉）。結果は business ごとに持つ（別の business の成功で、時刻の来ていない business の失敗を消さない）。Mac が止まっていた週は、次に動いた回で取る
- 世代の入れ替えは数だけ（臨時のバックアップも同じ 10 枠）。短い間に何度も中身が変わると古い世代から消える＝長く残したい版は Human が `restore` で別の file にするか、Dropbox の版の履歴を使う

### 4-1. 工程表の読み方（2026-11-16・実の工程表の形に合わせた）

実の工程表は「1 行目に日付が横に並び（1 日が 2 列・見出しは結合）、2 行目が曜日、左の 2 列が行の名前（2 行を結合）、交わる所が予定」の表で、4 か月半ごとの sheet が新しい順に並ぶ。
前の読み方（query を含む**行**を返す）では 1 行が 4 か月半ぶんになり、結果の上限も越えた。今は日付で抜き出す：

| params | 返す物 |
|---|---|
| `{}` | 今日から 7 日（「今日」は config の `utc_offset_minutes` の時刻） |
| `{"date":"YYYY-MM-DD"}` | その日 |
| `{"from":"…","to":"…"}` | 期間（31 日まで。越えたぶん・bytes の上限で切ったぶんは `truncated` と `next_from`） |
| `{"query":"…"}` | 今日以後で、その文字を含む予定か行の名前（`from`・`to` をつければ過去も）。`matched` は全部の数 |
| `sheet`・`file` | sheet・2 つ目以降の工程表の指定（任意） |

- 返す形：`days: [{ date, weekday, items: [{ r, label, text }] }]`（query は `hits: [{ date, r, label, text }]`）。`label` は左の列の名前（結合された名前は下の行にも付く・名前の無い行には付けない＝上の行の名前を借りない）。`r` は Excel の行の番号
- 切る所は日の境：`next_from` は「まだ 1 つも返していない最初の日」＝`next_from` から聞き直して集めれば、落ちも重なりも無い。1 日ぶんだけで上限を越える時だけ、その日を途中まで返す（`partial: true`／query は `partial_date`。落とした数は `omitted`＝query で絞る）。`next_from` は頼まれた期間を越えない
- sheet は**日ごとに**、その日を含む最初の sheet（並びの順）。期間が 2 つの sheet にまたがれば両方から読む（`sheets_used`）。`sheet` を指定した時はその sheet だけ。`range` は全部の sheet を合わせた期間。在る期間より前後にはみ出した期間は在る側へ寄せる。どの sheet にも無い期間は `out_of_range: true` と各 sheet の期間（`ranges`）
- **隣の sheet と重なる 2 週間ほどは、sheet によって中身が違う**（実の工程表で確かめた：重なる日の 8 割で違う）。既定は並びの先（新しい sheet）を読む＝古い sheet の側を見たい時は `sheet` を指定する。どちらを正とするかは Human の決まり（台帳 `schedule-overlap-rule`）
- 何日かにまたがって結合された予定は、またがる日のすべてに出す。縦に結合された予定は上の行にだけ出す。非表示の行も返す
- 中身の無い行（`<row …/>`）・数式の文字の結果（`t="str"`）・真偽・エラーの cell で行の番号や日付の判定がずれない（2026-11-16 監査）
- **ふりがなを足さない**：日本語の Excel は共有の文字にふりがな（`rPh`）を持つ（実の工程表では共有の文字の 7 割）。前はふりがなが文字の後ろに付き、検索にも当たっていた
- 日付の見出しの無い表（行が予定の普通の表）は、前のとおり query を含む行（`mode: "rows"`）。日付の指定は `schedule_not_calendar`
- 日付の判定は「35000〜60000 の整数」（書式は見ない）＝日付の見出しの行は「中身のある最初の 12 行のうち、日付らしい数が 5 つ以上・1 日ずつ進む並びが 8 割以上」の行。1904 年から数える workbook（古い Mac の Excel）は 1462 日ずらす
- 見出しのすぐ下の行を曜日の行と見るのは「日付の列の 8 割以上に 4 字までの文字・文字の種類が 10 まで・ほかの cell が無い」時だけ（2 行目から予定の表で、予定を曜日と取り違えて落とさない）
- cell のコメント（メモ）・色・罫線は読まない（色で意味を持たせた予定は文字に出ない）

## 5. 現場カルテ（AI が書式を作り、Human が追記・編集）

- 置き場所：App folder の `<output_root>/karte/<案件ID>.md`（Dropbox で Human がそのまま開いて書ける）
- 書式：現場名・案件ID・所在地・現地調査日・作業予定・工事内容・建物形状・階数・高さ・外周寸法・足場面積の概算・使用材料・カーポート・下屋・妻面・寄棟などの特殊条件・搬入経路・近隣・道路条件・安全上の注意事項・写真・図面への参照・見積書への参照・工程表への参照・現調履歴・Humanの追記・修正履歴・AIによる整理・提案・未確認事項
- 無い値は「未確認」（AI は渡された値だけを書く＝事実を作らない。値の出所は依頼＝Task Hub の task に残り、囲みの `task=<id>` でたどれる。**依頼する側〈Bot〉が作った値かどうかは code では分からない**＝Human がカルテを読んで直す）。書式の「未確認」の行は印つき（`未確認 <!-- placeholder -->`・表示には出ない）：その節に AI が値を差し込む時、**書式の位置（見出しの下の最初の行）にある、印つきのまま 1 文字も変わっていない 1 行だけ**を外す（値が入ったのに「未確認」が残らない）。Human が自分で書いた「未確認」・書き換えた行・項目の下に写した同じ行は Human の文＝触らない（2026-11-16。CRLF で保存された file でも同じ）
- 文字：カルテの部品は渡された文字のまま書く（NFC。NFKC にしない）。**ただし Task Hub の受け口（envelope）が依頼の文字を NFKC に揃える**＝Bot・CLI からの依頼では「㎡」→「m2」・「①」→「1」・「㈱」→「(株)」・「Ａ邸」→「A邸」になって届く（2026-11-16 に確かめた。Human が承認する全文もその形＝承認した文と書く文は同じ。全角のまま残すには受け口の決まりを変える＝§7）。file は UTF-8 だけ：Human が Shift_JIS・UTF-16 で保存し直した file は読まない・書かない（`karte_not_utf8`＝化けた文を上げ直さない。UTF-8 で保存し直せば続けられる）
- 出所：AI が書いた所は `<!-- ai:<日時> task=<id> -->` 〜 `<!-- /ai -->`。囲みの外は Human
- Human の追記を消さない：AI は既存の文字を 1 文字も変えず、節の末尾に囲みを差し込むだけ。上げる時は rev つき（Human が同時に直していたら読み直して差し込み直す）。同じ依頼のやり直しは二重にしない
- 履歴：上げる前の版を `business-backups/<business>/karte-history/` に残す（Dropbox の版の履歴とあわせて戻せる）
- 報告：`karte.report` は作業予定・注意事項・未確認事項・現調履歴の抜き出しと、まだ「未確認」のままの項目の一覧（AI の要約ではない）。手書きのメモの読み取り・AI の要約は Hermes（有料）の段で後日
- 既存の業務アプリとの関係：足場見積アプリ・足場計算ツールは設計の段で、案件の台帳は無い＝カルテを新しい台帳にしない（案件ID は Human の決める ID をそのまま使う）

### 5-1. Vault の `karte-v1` との整合（2026-11-23・二重に作らない）

2026-11-23 に Vault の側で、カルテの構造の契約 `karte-v1` と、計算エンジンへの変換層 `karte-adapter` v0 ができた（足場計算ツール APP-039 の側。全体構成設計案 v1 §4-2・§11）。
同じ設計案で、どれを正にするか（H-3：案件ノート／`karte.json`）、置き場所（H-15）、現場ID の形式（H-17）は未決。

- この Mac のカルテ（App folder の Markdown）は**置き場所の候補の 1 つ**で、2 つ目のカルテの構造ではない。H-3・H-15 が決まるまで、**ここにカルテの機能を足さない**。節・計算の項目・`karte.json`・値の出所の段階は足さない。今の書式・差し込み・報告は保守だけ。
- 節の対応（`karte-v1` の節 ← この Mac の項目）：
  - 基本情報 ← 現場名・案件ID・所在地・現地調査日・作業予定・工事内容
  - 建物・敷地 ← 建物形状・階数・高さ・外周寸法・特殊条件・近隣・道路条件
  - 足場条件 ← 足場面積の概算・使用材料・搬入経路
  - 注意点・特記事項 ← 安全上の注意事項
  - 未確認事項 ← 未確認事項
  - 添付 ← 写真・図面・見積書・工程表への参照
  - 口述ログ（追記専用） ← **無い**。近いのは現調履歴と AI の囲み
- 値の出所：`karte-v1` は値ごとに出所の段階を持つ（measured／drawing／selected／rough／assumed／ai_estimated／unconfirmed）。formal には確認者と確認日が要る。この Mac のカルテは「未確認」と AI の囲み（`task=<id>`）だけで、確認者の欄は無い。計算・正式見積の入力には使えない。
- H-3 が (a)・(c)（`karte.json` が正）なら、この Markdown は生成される表示になる。(b)（案件ノートが正）なら、置き場所（H-15）が Dropbox かどうかで、この差し込みの仕組みを残すかが決まる。どちらでも、`karte-adapter` が読むのは `KarteV1` だけで、この Mac の Markdown を直接読ませない。

## 6. 見積書の AI 作業版

- 原本は読むだけ（読みの資格情報）。AI 作業版は App folder の `estimates/<原本の名前>_AI作業版.xlsx`（xlsm はそのまま xlsm）
- 1 回目は原本の写しに AI の tab を足して作る。2 回目からは AI 作業版に足す（Human がその写しに書いた物も残る）
- AI の tab：名前は `AI_` で始まる（例 `AI_案1`）。項目・仕様・数量・単位・単価・金額（=数量*単価）・備考と合計（=SUM）。値も入れる
- 直せるのは「台帳に AI が作ったと記録した `AI_` の tab」だけ（Human が `AI_` の名前を付けた tab も直さない）
- **保存の前の確かめ**：Human の tab の部品・画像・マクロ（vbaProject.bin）・styles・定義名・印刷設定・外部リンクは圧縮された bytes のまま 1 byte も同じ・workbook.xml 等は足した 1 行を除けば同じ。違えば保存しない（`xlsx_preserve_failed`）
- 上げる時は rev つき（Excel で開いて保存した直後などの同時の変更は conflict＝上書きしない）。上げる前の版は `business-backups/<business>/estimates/history/` に残す
- **保存の前後の差分**（2026-11-16）：結果の `diff` に、何から作ったか（原本／AI 作業版）・tab の一覧の前後・明細の行数と合計（直しは前後）・圧縮された bytes のまま同じだった部品の数・前の版の hash（Mac の履歴に残した版）。前の形が読めない時（Human がその tab を作り変えた）は数を作らず null。台帳には写した原本の版（rev・content_hash）を残す
- 文字：渡された文字のまま書く（NFKC にしない＝Human が承認した全文と違う文字にならない。受け口が NFKC に揃えた後の文字＝§5 の「文字」）
- 全角を含む名前（2026-11-16）：原本の path は実の名前に直してから読む（§2-1）。AI 作業版の名前は実の原本の名前から作る＝`estimate.ai.edit` の `working_name` は、受け口が半角にした名前でも台帳から畳んで探す（同じに畳まれる写しが 2 つなら `estimate_copy_ambiguous`）
- **Human が参照している AI の tab は作り直さない**（`estimate_ai_sheet_referenced`）：作り直すと合計の cell の位置が動き、Human の tab・定義名・グラフの数式が（1 byte も変わらないまま）別の値を指す。探す形は「名前!」「'名前'!」・ピボットの元・複数の tab にまたがる範囲（どの tab の範囲でも止まる側）。AI の tab 自身の印刷範囲・フィルターは参照に数えない。Human が決める：新しい AI の tab を足す（`estimate.ai.create`）か、参照を外す
- Human が「ブックの構成を保護」した見積には tab を足さない（`estimate_workbook_structure_locked`）
- 扱えない file：古い `.xls`・パスワードつき・zip64 は止める（上書きしない）
- 原本からの移動：原本を変えずに移れる方法として、Grok の返事に AI 作業版の path を返す（原本にリンクを足す編集はしない）。App folder は原本と別の場所になる（書く資格情報を App folder に閉じ込めるための代わり）

## 7. 残る限界（受け入れ・記録）

- 読みの app は Full Dropbox の読み取り（Dropbox の scope はフォルダで絞れない）＝許可フォルダは code（scope.mjs）が強制。書けないことは資格情報が強制
- Dropbox の Smart Sync・オンラインのみの file は API で取るので関係しない。大きな file（64 MiB 超）は取らない
- AI 作業版・カルテは原本と別の場所（App folder）にある
- path は NFC にそろえて Dropbox へ送る（macOS から貼った NFD の名前も同じに比べる）。実の Dropbox は NFD で聞いても同じ file を返した（2026-11-16）＝NFC／NFD は問題にならない。全角と半角は別の名前（§2-1）
- 見積の AI 作業版：台帳に書いた直後・上げる前に process が止まると、台帳に在って file に無い tab が残る（次の作成で名前の重複は拒否されるので、別の名前で作る）
- 独立監査（2026-11-13）：should-fix 11・nit 11 を直し、再検証で出た 4 件（閉じていない ai の印・# の値・calcChain の tag・sheetId の台帳）も直した
- 独立監査（2026-11-16 夜・実の接続の後の差分。権限の境 1 本＋工程表の読み方 1 本）：必ず直す物は権限の境に無し・読み方に 1 件（中身の無い行 `<row …/>` が次の行を飲み込み、行の番号と班の名前がずれる）。
  直した物＝畳むと同じ名前の許可フォルダの取り違え・一覧の上限で切れた時の取り違え・書いた後の `result_too_large`・検索の上限が「全部」に見える・断る側が前より狭い 1 組の文字・期間が sheet をまたぐ時の古い sheet・進まない `next_from`・曜日の行の判定。試験は `tests/dropbox-live-prep-20261116.test.mjs`
- 独立監査（2026-11-16・本番接続の前。権限の境と仕様の照合の 2 本＋直した差分の再検品 1 本）：直した物＝UTF-8 でないカルテを化けさせて上げ直す・時間切れの後の古い試行が後から書く（client の時間切れと中止が本文の読み込みに効いていなかった）・同じ task の二重の差し込み・広い read_roots の中の見積〈L2〉が承認なしの一覧に出る・資格情報が無いままのバックアップが ok と出る・書式の「未確認」が値の後も残る・NFKC が文字を変える・Human が参照している AI の tab の作り直し・保存の前後の差分が無い・書きの app が App folder かを人の答えだけで決めていた・書ける config を週の回が使う。試験は `tests/dropbox-audit-20261116.test.mjs`
- **許可フォルダが絞るのは Task Hub の handler だけ**（2026-11-16 監査）：読みの資格情報（Full Dropbox の読み取り）は Keychain に在り、handler と同じ OS ユーザーで動く他の process は Keychain から読める＝その process は許可フォルダの外も読める（書けはしない＝読みの app は書く scope を持たない）。Hermes は別のユーザー＋sandbox で Keychain を読めない。強くするなら業務の handler を専用の OS ユーザーと専用の Keychain で動かす（**Human の判断**）。それまでは「読みの資格情報を入れる＝handler を動かす OS ユーザーに Dropbox 全体の読み取りを預ける」として扱う
- 手元の写しの保持：カルテの履歴（`karte-history/`）と見積の前の版（`estimates/history/`・L2）は Mac の `business-backups/`（0700・GitHub のバックアップの外）に上限なしで残る＝定期の整理は未実装（Human が保持の期間を決めた後）
- 工程表の世代の index（`index.json`）が壊れると世代の一覧は空から始まる（file は消さない＝残った世代は手で戻せる）
- Task Hub の source に複数の business を許すと、その source の channel はどの business も名乗れる（EN司令塔は e-nexus だけ＝今は該当しない。E-STEP を別の Bot に開く時は source を分ける）
- **実の Dropbox で確かめた物**（2026-11-16・読むだけ。書いていない・保存していない）：
  - 読みの client：metadata・一覧・検索・取得（`content_hash` の照らし・日本語の path の header）・file なしの error の語（`path/not_found` → `dropbox_path_not_found`）
  - NFD で聞いても見つかる・全角と半角は別の名前・`search_v2` は中身も探す・refresh の応答に scope は無い
  - 書きの資格情報は Dropbox の一番上・許可フォルダ・工程表のどれも見えない（App folder の app）。App folder は空
  - 読む handler（一覧・検索・工程表の読み取り・世代の一覧・無いカルテ）は、受け口と同じ正規化を通した依頼で動いた。工程表は日付で読める形
  - 見積の AI 作業版の作り（zip の編集）は、実の Excel が保存した workbook（48 部品・コメント・印刷の設定つき）でも「元の部品は 1 byte も同じ」の確かめを通り、出来た zip は別の読み手（Python の zipfile と XML の parser）でも壊れていない（手元の memory の中だけ・上げていない）
- **まだ確かめていない物**（書く・保存するので Human の承認の後。最初の検収で見る）：rev の不一致の error の語（`path/conflict`）・App folder へ上げた後の `content_hash`・カルテの作成と追記・復元の別 file・工程表のバックアップの保存と世代・**Excel が AI の tab を修復なしで開くか**（Human が Excel で開く）
- Task Hub の受け口（envelope）は依頼の文字を NFKC に揃える（2026-11-16 に確かめた）：カルテ・見積に書く文字は全角の記号が半角になって届く（§5）。全角のまま書きたいなら受け口の決まりを変える（Task Hub の関所の変更＝**Human の判断**。承認の指紋・鍵の形の検査と一緒に見直す）
- 依頼の path を実の名前に直す時、1 段の一覧は 2000 件まで（それより多いフォルダの全角の名前は `path_not_found` か `path_ambiguous`＝止まる側）。名前の前後が空白の部分・全角の逆斜線「＼」を含む名前は依頼では指せない（`dropbox_path_invalid`）。選んだ後は戻らない＝全角の斜線「／」を含む名前は、同じ始まりの別の名前が在ると指せないことがある
- `dropbox-preflight` は確かめのために許可フォルダの外も読む（無い path の親の一覧・同じ名前の file の検索＝Dropbox 全体）。出すのは数だけ・`--show-paths` の時も読ませない場所の中の path は出さない
- **新旧の元請フォルダの差（2026-11-18・metadata と構造の集計だけを読んだ。本文は出していない・保存していない・コピー・移動・削除はしていない）**：
  旧の木の元請は 651 file・今の木は 699 file。同じ path で中身も同じ 627・同じ path で中身が違う 14・旧にだけ在る 10・今にだけ在る 58。
  - 同じ path で中身が違う 14：13 は今の木の方が新しい（file 自身の更新日。再アップロードの日ではない）。**1 つだけ旧の方が新しい**（旧で 2026-04-18 に直した見積の xlsx。3 つの sheet・149 cell のうち違うのは 1 cell〈数値〉だけ。file の大きさは旧が 3 倍＝書式・画像の差）。もう 1 つ旧で 04-18 に直した file は今の木で 10-22 に直され、2 cell が違い、旧にだけ・今にだけの cell が 1 つずつ（人が見比べる）
  - 旧にだけ在る 10：①今の木の整理されたフォルダに同じ内容が在る 1 ②旧の中の同じ file の別置きの写し 4（旧の中の整理されたフォルダの版と同じ内容が 3・残る 1 は 2,337 ブロック中 1 ブロックだけ違う。今の木には整理されたフォルダの版が在り、編集後で内容が違う〈最も近い 1 つは 2 ブロックだけの差＝再保存程度〉）＝今の木に移す必要は無い ③取引先 1 社の安全書類のフォルダ 4 file（作業員名簿・在留カードの写し〈zip〉・車両の書類。個人の書類を含む）＝今の木には親フォルダごと無い（意図して消した可能性・移すと個人の書類が許可フォルダの近くに戻る）④画像だけの PDF の scan 1 つ（6 頁・内容は読んでいない）
  - 今の木の元請には、名前が個人の書類らしい file が約 26 在る（作業員名簿 15・保険証 3・安全書類 11 など。10 か所のフォルダ）＝元請を許可フォルダに足す前に名前の拒否（上）で見えなくなることを確かめる。`deny_names` に安全書類・新規入場を足すかは Human（現場の安全書類を Grok に探させたいなら足さない）
  - 名前入りの一覧は、Human が Claude Code に「旧の木にだけある file を出して」と言えば画面にだけ出す（repo・log・台帳には書かない）
- 工程表の読み方（§4-1）は実の工程表 1 つの形で確かめた。形を変えると（日付の行を 13 行目より下へ・日付を文字で書く）日付で読めなくなり、行の読み方に戻る（`dropbox-preflight --deep` で分かる）

## 8. 承認の後の最短手順（2026-11-18・準備だけ済み。どれも Human の承認が先）

| 段 | 内容 | 誰 | 承認 |
|---|---|---|---|
| 1 | 許可フォルダ：案（`mac-runtime-state/task-hub/config.DROPBOX.E-STEP.PROPOSAL.json`・実の Dropbox に照らし済み）を本番の `config.json` の `dropbox` へ写す（前の config は `config.json.before-<日付>` に残す・0600）→ `node scripts/dropbox-preflight.mjs --deep`（problem 0・warning は同じ名前の古い写しの 1 件だけが想定）。**写すのは `dropbox` の節だけ**（sources・intents は変えない） | Claude Code | **許可フォルダの承認**（案 A でよいか・元請を足すか・保留の 5 フォルダ・`deny_names`） |
| 2 | 読むだけの検収：human-cli の依頼で `dropbox.list`・`dropbox.search`・`schedule.read`（既定・日付・期間・query）。書かない | Claude Code | 1 の承認に含む |
| 3 | 最初の書き込みの検収：`schedule.backup` 1 回（Mac の `business-backups` に保存・Dropbox には書かない）→ 試験のカルテ（作成・追記・報告）→ `schedule.restore`（App folder の `restore/` へ別 file）→ 試験の見積 1 件（`estimate.ai.create`・毎回 Mac で承認）を Human が Excel で修復なしに開けるか | Claude Code が実行・Human が Excel で確認 | **書き込みの承認**（ledger `dropbox-first-write-acceptance`） |
| 4 | EN司令塔への公開：EN司令塔は business `e-nexus` だけ＝① business に `e-step` を足す（Mac の config の `grok-commander.businesses`・VPS の `--businesses e-nexus,e-step`）か ② E-STEP 用の Bot を別に作る。許可する intent は段階で足す：先に読むだけ（`dropbox.list`・`dropbox.search`・`schedule.read`・`karte.get`・`karte.search`・`karte.report`）、次に書く物（`karte.create`・`karte.append`・`schedule.backup`・`schedule.backup.list`）、最後に毎回 Mac で承認する物（`estimate.ai.create`・`estimate.ai.edit`・`schedule.restore`）。VPS は `connect-from-mac.sh --ssh <いつもの> --intake --source grok-commander --intents <今の 5 つ＋足す物> --businesses e-nexus,e-step`（鍵は作り直さない）。EN司令塔の指示文に呼び方の例を足す（`docs/grok-bot.md` §6 の表） | Human（VPS の ssh・Grok の画面）・Claude Code（Mac の config・検収） | **公開の承認**（ledger `dropbox-grok-exposure`） |

- 4 の前に、許可フォルダ・名前の拒否が本番の config で効いていること（2）と、EN司令塔の鍵の businesses が `e-step` を含む時に **E-NEXUS の business は Dropbox の設定が無い＝閉じたまま**であること（`dropbox_business_not_enabled`）を確かめる
- Dropbox の資格情報の失敗（切れた・障害）が続いても Task Hub 全体は止まらない：Dropbox の task だけ一時止まる（`docs/task-hub.md` §5「機能ごとの回路遮断」）。状況は `status.query {detail:true}` の `suspended`


### 8-1. 段 2（読むだけの検収）の実機の結果（2026-11-24）

本番の store・本番の config（e-step・read_only）で、source human-cli の依頼を 5 分ごとの回（LaunchAgent）に通した。Dropbox へは書いていない。名前・path は Mac の store にだけ残り、ここには書かない。

| 依頼 | 結果 |
|---|---|
| `dropbox.list`（許可フォルダの 1 つ目） | succeeded（Decision Layer の tier auto・読みの資格情報・一覧 1 件） |
| `dropbox.search`（同じフォルダ・query `pdf`） | succeeded（範囲の中の 1 件） |
| `schedule.read {}`（今日から 7 日） | succeeded（calendar の形・7 日・truncated なし） |
| `dropbox.list`（許可フォルダの外の path） | failed `dropbox_path_not_allowed`（Dropbox に聞く前に止まる） |
| `dropbox.list`（許可フォルダの下の「給与」） | failed `dropbox_path_not_allowed`（名前で読ませない共通の下限） |

- 拒否の 2 件は想定内の失敗（回路遮断に数えない）。ただし、その回の `task-hub-cycle` の記録は 1 回だけ `problem`（run の段が失敗の task を含む時の決まり）。host-health の通知は 2 回続いた時だけなので、通知は出ない
- 同じ回の後に human-cli の `task.status {view:"failed"}` が、拒否の 2 件と `next_steps`（`dropbox_path_not_allowed`＝who human・retry no）を返した（`docs/grok-bot.md` §8）。次の回の記録は `ok` に戻った
- 段 1（許可フォルダの承認）は、台帳の `dropbox-folders` が open のまま（config は 2026-11-20 に適用済み）。閉じてよいかは Human が決める

### 5-2. 現場の口述の受け付け（2026-11-24・Human 決定 E）

Grok・Mac の端末から話した・書いた現場の内容は、`note.record` の `kind: "dictation"`（`site`＝現場名・`recorded_on`・`channel`）で Task Hub の口述の記録（business ごと・追記だけ・prune で詰めない）に残す。新しい intent・新しいカルテの正本は作らない。

- Mac は**構造化も確定もしない**。寸法の候補・出所の段階（rough／assumed など）・確認は APP 側の `karte-adapter`（`dictation-input-v1` → `dictation-extraction-v1` → `karte-diff-v1`）と Human の担当。「約 6m」は原文のまま残り、Mac が数値にしない＝APP-039 の正式な計算に混ざらない
- 同じ現場・同じ日・同じ文の出し直しは 1 件（`duplicate: true`）。訂正は新しい口述として足す（前の行を消さない＝変更の前と後が両方残る）。版の照合・古い版での上書きの拒否は `karte-diff-v1` の側（APP-040）
- 結果に内部の ID（task・記録）と原文を返さない。返すのは `recorded`・現場名・日付だけ（決定 G）
- APP 側への渡し方：`node scripts/karte-dictation-export.mjs --business <b> --out <file>` が `dictation-input-v1` の JSONL を書く（`input_id` は Mac の記録から作る固定の値・`case_id` は case_ref か現場名＝H-17 が決まるまでの仮）。置き場所（H-3・H-15）が決まるまで、自動では渡さない
- **原文と解析用の文（2026-11-24 に直した）**：受け口は params を NFKC に揃える（鍵の形・見た目の同じ文字の検査のため）。`params.text` が揃えで変わった時は、受け取ったままの文を task の `raw_text` に別に残し、口述の記録は `text`＝原文・`text_normalized`＝揃えた形。承認の digest と params は変えない。見えない文字を含む原文は残さない。書き出し（`dictation-input-v1`）は原文
- EN司令塔からの e-step の口述は、今は `business_intents` の外＝毎回 Mac で承認（公開は台帳 `dropbox-grok-exposure` の次の段）

## 9. 2026-11-24 の Human 決定（A〜G）と実装の対応

正本は Vault の側（Windows が反映する）。ここは Mac Runtime の実装の対応だけ。

| 決定 | 内容 | Mac Runtime の今 |
|---|---|---|
| A 原本の完全保護 | 工程表・元請・図面・見積・請求・現場資料を AI が変更・上書き・移動・削除しない。原本の資格情報は読み取り専用 | 実装済み・実機で確認済み：読みの資格情報（scope は metadata.read・content.read だけ）と client（書く呼び出しが無い）の 2 重・本番の書き込み 0 件 |
| B 読む範囲の拡大・外へ渡す範囲の別管理 | 「元請」の名前だけで全部を断る方針を見直す。Mac で読める範囲と Grok へ渡せる範囲を分ける。給与・名簿・個人情報・認証情報・機密の契約は個別に | **実装済み・模擬で検証済み**：`scope.external`（`allow_roots`・`deny_roots`・`deny_names`。狭めるだけ）で、human-cli 以外の依頼元へ返す名前・中身を絞る（在るか無いかも同じ答え・工程表は丸ごと）。共通の下限（給与・名簿・保険証・Secret など）は Mac でも外でも効く。**本番の config は変えていない**＝元請は今も deny（拡げるのは Human の承認：台帳 `dropbox-read-expansion`） |
| C AI の一時コピー | 原本はコピーの上で加工。PDF・画像化は Mac の隔離された一時コピー・Excel は作業コピー | 既に在る形：PDF は承認の後に Mac の `pdf-staging`（0600・rev と content_hash を照合）、見積は App folder の AI 作業版（Human の部品は 1 byte も変えない）。`ai-copy` の場所と自動の削除（範囲・保持の期間・失敗の時）は未実装＝Human の承認の後 |
| D AI 業務フォルダ | EN-AI-Output（karte・estimates・reports・restore）を再利用、ai-copy を候補 | 書きの資格情報は App folder だけ（EN-Reader と別）。`output_root` の下の種類は今の 4 つ。ai-copy は足していない。最初の書き込みは台帳 `dropbox-first-write-acceptance` の後 |
| E カルテは AI 主体 | 口述の原文・日時・候補・確定値と未確認値・訂正・履歴・参照。1 案件 1 カルテ | 受け付けと原文の記録まで実装（§5-2）。構造化・版・差分は APP 側の karte-adapter を使う（二重に作らない）。Mac の Markdown のカルテは H-3・H-15 まで機能を足さない（§5-1） |
| F 写真・書類の紐付け | 実体は今の場所・ID と参照で結ぶ・LINK の写真は LINK の file-gateway | `resolveById`（Dropbox の ID → 実の path → 許可の判定）は準備済み・未接続。写真の upload の仕組みは Mac に作らない |
| G 内部 ID の通常の非表示 | 現場 ID・写真 ID・Dropbox ID・task ID は画面・PDF・カルテの本文に出さない。聞かれた時だけ | 口述の結果は ID を返さない。結果の板の上の段の `task_id` は受け渡しの契約として残す（Grok の指示文で「聞かれない限り出さない」・docs/grok-bot.md §10）。ID を隠すことを機密の保護の代わりにはしない |

### 9-1. スキャンの保存先（2026-11-24・実の Dropbox で読むだけで確かめた）

- 一番上にスキャンのフォルダが 2 つ：今使っている側（約 330 file・PDF が 9 割・約 150 MiB・2026-11 まで更新）と、2026-03 に写した前の写し（中身の 98% が今の側と同じ＝足さない）
- 中は作業員の資格証・安全書類・提出書類が多く、約 1/3 は名前の共通の下限に当たる。**資格証は下限の語に無い**＝名前で絞れない個人の書類が中心
- 案（未適用・台帳 `dropbox-scan-folder`）：今の側を e-step の read_roots に足し、`external.deny_roots` で同じフォルダを外へ返さない＝Mac の端末（human-cli）だけが一覧・検索できる。PDF の取り出しは `pdf_roots` の別の承認と、毎回の Mac での承認
- 画像だけの PDF の文字の検索（OCR）は、この Mac の今の道具に無い。新しい有料の OCR は入れない（必要なら別の判断）
