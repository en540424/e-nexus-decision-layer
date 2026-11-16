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

追加の契約・課金は無い（Dropbox の API app は無料）。

## 2. 許可フォルダ（business ごと・Human の承認の後に config へ）

```json
"dropbox": { "businesses": { "e-step": {
  "read_roots": ["/<現場資料のフォルダ>"],
  "schedule_files": ["/<工程表の xlsx>"],
  "estimate_roots": ["/<見積書の原本のフォルダ>"],
  "deny_roots": ["/<読ませないフォルダ>"],
  "output_root": "/e-step"
} } }
```

- business が無い＝その business の Dropbox は閉じている（`dropbox_business_not_enabled`）。**E-STEP は e-nexus の権限から広げない**（business ごとに別の表・Task Hub の source の businesses とも 2 重）
- 読みは `read_roots`・`estimate_roots` の下と `schedule_files` だけ（大文字小文字は同じに比べる・`..`・空の部分・見えない文字〈零幅・bidi の向き〉は拒否）
- **承認なしの一覧・検索（`dropbox.list`・`dropbox.search`）に出るのは「`read_roots` の中」かつ「`estimate_roots`・`deny_roots` の外」だけ**（2026-11-16）：現場のフォルダの中に見積のフォルダがある並びでも、広い `read_roots` をそのまま書ける（見積のフォルダは名前も出ない・Dropbox が返した結果も 1 件ずつ絞る）
- `deny_roots`（任意）：`read_roots` の中でも読ませない場所（給与・人事・個人）。どの読み方でも拒否。その中に工程表・見積の原本を置く設定は読み込まない
- 書きは App folder の `<output_root>/{karte,estimates,reports,restore}/` だけ
- 機密の段階（Vault のレビュー L）：見積・顧客・取引（L2）を AI が読むのは毎回 Human の承認＝`estimate.ai.*` は `human_required`。給与・個人・人事（L3）のフォルダは許可フォルダに入れない

## 3. 依頼（Task Hub の intent・AI を使わない）

| intent | class | 内容 |
|---|---|---|
| `dropbox.search`・`dropbox.list` | auto | 許可フォルダの中の検索・一覧（名前・path・大きさ・更新時刻） |
| `schedule.read` | auto | 工程表を読むだけ（query を含む行・sheet）。**工程表に書く道は無い**（読みの資格情報・書く handler なし） |
| `schedule.backup`・`schedule.backup.list`・`schedule.restore` | auto | §4 |
| `karte.create`・`karte.get`・`karte.append`・`karte.search`・`karte.report` | auto | §5 |
| `estimate.ai.create`・`estimate.ai.edit` | human_required | §6 |

EN司令塔（grok-commander）へ出すのは Human の承認の後（config の `grok-commander.intents` と VPS の `--intents`）。今は Mac の Human（human-cli）からだけ。

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

## 5. 現場カルテ（AI が書式を作り、Human が追記・編集）

- 置き場所：App folder の `<output_root>/karte/<案件ID>.md`（Dropbox で Human がそのまま開いて書ける）
- 書式：現場名・案件ID・所在地・現地調査日・作業予定・工事内容・建物形状・階数・高さ・外周寸法・足場面積の概算・使用材料・カーポート・下屋・妻面・寄棟などの特殊条件・搬入経路・近隣・道路条件・安全上の注意事項・写真・図面への参照・見積書への参照・工程表への参照・現調履歴・Humanの追記・修正履歴・AIによる整理・提案・未確認事項
- 無い値は「未確認」（AI は渡された値だけを書く＝事実を作らない。値の出所は依頼＝Task Hub の task に残り、囲みの `task=<id>` でたどれる。**依頼する側〈Bot〉が作った値かどうかは code では分からない**＝Human がカルテを読んで直す）。書式の「未確認」の行は印つき（`未確認 <!-- placeholder -->`・表示には出ない）：その節に AI が値を差し込む時、**書式の位置（見出しの下の最初の行）にある、印つきのまま 1 文字も変わっていない 1 行だけ**を外す（値が入ったのに「未確認」が残らない）。Human が自分で書いた「未確認」・書き換えた行・項目の下に写した同じ行は Human の文＝触らない（2026-11-16。CRLF で保存された file でも同じ）
- 文字：書くのは依頼の文字のまま（NFC。NFKC にしない＝「㎡」「①」「㈱」「Ａ邸」を別の文字に変えない）。file は UTF-8 だけ：Human が Shift_JIS・UTF-16 で保存し直した file は読まない・書かない（`karte_not_utf8`＝化けた文を上げ直さない。UTF-8 で保存し直せば続けられる）
- 出所：AI が書いた所は `<!-- ai:<日時> task=<id> -->` 〜 `<!-- /ai -->`。囲みの外は Human
- Human の追記を消さない：AI は既存の文字を 1 文字も変えず、節の末尾に囲みを差し込むだけ。上げる時は rev つき（Human が同時に直していたら読み直して差し込み直す）。同じ依頼のやり直しは二重にしない
- 履歴：上げる前の版を `business-backups/<business>/karte-history/` に残す（Dropbox の版の履歴とあわせて戻せる）
- 報告：`karte.report` は作業予定・注意事項・未確認事項・現調履歴の抜き出しと、まだ「未確認」のままの項目の一覧（AI の要約ではない）。手書きのメモの読み取り・AI の要約は Hermes（有料）の段で後日
- 既存の業務アプリとの関係：足場見積アプリ・足場計算ツールは設計の段で、案件の台帳は無い＝カルテを新しい台帳にしない（案件ID は Human の決める ID をそのまま使う）

## 6. 見積書の AI 作業版

- 原本は読むだけ（読みの資格情報）。AI 作業版は App folder の `estimates/<原本の名前>_AI作業版.xlsx`（xlsm はそのまま xlsm）
- 1 回目は原本の写しに AI の tab を足して作る。2 回目からは AI 作業版に足す（Human がその写しに書いた物も残る）
- AI の tab：名前は `AI_` で始まる（例 `AI_案1`）。項目・仕様・数量・単位・単価・金額（=数量*単価）・備考と合計（=SUM）。値も入れる
- 直せるのは「台帳に AI が作ったと記録した `AI_` の tab」だけ（Human が `AI_` の名前を付けた tab も直さない）
- **保存の前の確かめ**：Human の tab の部品・画像・マクロ（vbaProject.bin）・styles・定義名・印刷設定・外部リンクは圧縮された bytes のまま 1 byte も同じ・workbook.xml 等は足した 1 行を除けば同じ。違えば保存しない（`xlsx_preserve_failed`）
- 上げる時は rev つき（Excel で開いて保存した直後などの同時の変更は conflict＝上書きしない）。上げる前の版は `business-backups/<business>/estimates/history/` に残す
- **保存の前後の差分**（2026-11-16）：結果の `diff` に、何から作ったか（原本／AI 作業版）・tab の一覧の前後・明細の行数と合計（直しは前後）・圧縮された bytes のまま同じだった部品の数・前の版の hash（Mac の履歴に残した版）。前の形が読めない時（Human がその tab を作り変えた）は数を作らず null。台帳には写した原本の版（rev・content_hash）を残す
- 文字：依頼の文字のまま書く（NFKC にしない＝Human が承認した全文と違う文字にならない）
- **Human が参照している AI の tab は作り直さない**（`estimate_ai_sheet_referenced`）：作り直すと合計の cell の位置が動き、Human の tab・定義名・グラフの数式が（1 byte も変わらないまま）別の値を指す。探す形は「名前!」「'名前'!」・ピボットの元・複数の tab にまたがる範囲（どの tab の範囲でも止まる側）。AI の tab 自身の印刷範囲・フィルターは参照に数えない。Human が決める：新しい AI の tab を足す（`estimate.ai.create`）か、参照を外す
- Human が「ブックの構成を保護」した見積には tab を足さない（`estimate_workbook_structure_locked`）
- 扱えない file：古い `.xls`・パスワードつき・zip64 は止める（上書きしない）
- 原本からの移動：原本を変えずに移れる方法として、Grok の返事に AI 作業版の path を返す（原本にリンクを足す編集はしない）。App folder は原本と別の場所になる（書く資格情報を App folder に閉じ込めるための代わり）

## 7. 残る限界（受け入れ・記録）

- 読みの app は Full Dropbox の読み取り（Dropbox の scope はフォルダで絞れない）＝許可フォルダは code（scope.mjs）が強制。書けないことは資格情報が強制
- Dropbox の Smart Sync・オンラインのみの file は API で取るので関係しない。大きな file（64 MiB 超）は取らない
- AI 作業版・カルテは原本と別の場所（App folder）にある
- path は NFC にそろえて Dropbox へ送る（macOS から貼った NFD の名前も同じに比べる）。Dropbox が NFD のままの名前を別に扱う場合は `path_not_found`（止まる側）＝最初の実の読み取りで確かめる
- 見積の AI 作業版：台帳に書いた直後・上げる前に process が止まると、台帳に在って file に無い tab が残る（次の作成で名前の重複は拒否されるので、別の名前で作る）
- 独立監査（2026-11-13）：should-fix 11・nit 11 を直し、再検証で出た 4 件（閉じていない ai の印・# の値・calcChain の tag・sheetId の台帳）も直した
- 独立監査（2026-11-16・本番接続の前。権限の境と仕様の照合の 2 本＋直した差分の再検品 1 本）：直した物＝UTF-8 でないカルテを化けさせて上げ直す・時間切れの後の古い試行が後から書く（client の時間切れと中止が本文の読み込みに効いていなかった）・同じ task の二重の差し込み・広い read_roots の中の見積〈L2〉が承認なしの一覧に出る・資格情報が無いままのバックアップが ok と出る・書式の「未確認」が値の後も残る・NFKC が文字を変える・Human が参照している AI の tab の作り直し・保存の前後の差分が無い・書きの app が App folder かを人の答えだけで決めていた・書ける config を週の回が使う。試験は `tests/dropbox-audit-20261116.test.mjs`
- **許可フォルダが絞るのは Task Hub の handler だけ**（2026-11-16 監査）：読みの資格情報（Full Dropbox の読み取り）は Keychain に在り、handler と同じ OS ユーザーで動く他の process は Keychain から読める＝その process は許可フォルダの外も読める（書けはしない＝読みの app は書く scope を持たない）。Hermes は別のユーザー＋sandbox で Keychain を読めない。強くするなら業務の handler を専用の OS ユーザーと専用の Keychain で動かす（**Human の判断**）。それまでは「読みの資格情報を入れる＝handler を動かす OS ユーザーに Dropbox 全体の読み取りを預ける」として扱う
- 手元の写しの保持：カルテの履歴（`karte-history/`）と見積の前の版（`estimates/history/`・L2）は Mac の `business-backups/`（0700・GitHub のバックアップの外）に上限なしで残る＝定期の整理は未実装（Human が保持の期間を決めた後）
- 工程表の世代の index（`index.json`）が壊れると世代の一覧は空から始まる（file は消さない＝残った世代は手で戻せる）
- Task Hub の source に複数の business を許すと、その source の channel はどの business も名乗れる（EN司令塔は e-nexus だけ＝今は該当しない。E-STEP を別の Bot に開く時は source を分ける）
- 実の Dropbox でしか確かめられない物（最初の接続の検収で見る）：NFD の名前の一致・rev の不一致と file なしの error の語（`path/conflict`・`path/not_found`）・token の応答の scope・全角や見えない文字の扱い・`search_v2` が中身も探すか・Excel が AI の tab を修復なしで開くか

