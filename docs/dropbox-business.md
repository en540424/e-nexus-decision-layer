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
3. `node scripts/dropbox-auth.mjs --role write --app-key <EN-AI-Output の App key>`（App folder を選んだかを y で確かめる）
4. 許可フォルダを決める（下の §2・**Human の承認**）→ Claude Code が config に書く

追加の契約・課金は無い（Dropbox の API app は無料）。

## 2. 許可フォルダ（business ごと・Human の承認の後に config へ）

```json
"dropbox": { "businesses": { "e-step": {
  "read_roots": ["/<現場資料のフォルダ>"],
  "schedule_files": ["/<工程表の xlsx>"],
  "estimate_roots": ["/<見積書の原本のフォルダ>"],
  "output_root": "/e-step"
} } }
```

- business が無い＝その business の Dropbox は閉じている（`dropbox_business_not_enabled`）。**E-STEP は e-nexus の権限から広げない**（business ごとに別の表・Task Hub の source の businesses とも 2 重）
- 読みは `read_roots`・`estimate_roots` の下と `schedule_files` だけ（大文字小文字は同じに比べる・`..`・空の部分は拒否）
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
- 見張り：host-health の `business_backup`（失敗した file がある・8 日以上成功していない）。Mac が止まっていた週は、次に動いた回で取る

## 5. 現場カルテ（AI が書式を作り、Human が追記・編集）

- 置き場所：App folder の `<output_root>/karte/<案件ID>.md`（Dropbox で Human がそのまま開いて書ける）
- 書式：現場名・案件ID・所在地・現地調査日・作業予定・工事内容・建物形状・階数・高さ・外周寸法・足場面積の概算・使用材料・カーポート・下屋・妻面・寄棟などの特殊条件・搬入経路・近隣・道路条件・安全上の注意事項・写真・図面への参照・見積書への参照・工程表への参照・現調履歴・Humanの追記・修正履歴・AIによる整理・提案・未確認事項
- 無い値は「未確認」（AI は渡された値だけを書く＝事実を作らない）
- 出所：AI が書いた所は `<!-- ai:<日時> task=<id> -->` 〜 `<!-- /ai -->`。囲みの外は Human
- Human の追記を消さない：AI は既存の文字を 1 文字も変えず、節の末尾に囲みを差し込むだけ。上げる時は rev つき（Human が同時に直していたら読み直して差し込み直す）。同じ依頼のやり直しは二重にしない
- 履歴：上げる前の版を `business-backups/<business>/karte-history/` に残す（Dropbox の版の履歴とあわせて戻せる）
- 報告：`karte.report` は作業予定・注意事項・未確認事項・現調履歴の抜き出し（AI の要約ではない）。手書きのメモの読み取り・AI の要約は Hermes（有料）の段で後日
- 既存の業務アプリとの関係：足場見積アプリ・足場計算ツールは設計の段で、案件の台帳は無い＝カルテを新しい台帳にしない（案件ID は Human の決める ID をそのまま使う）

## 6. 見積書の AI 作業版

- 原本は読むだけ（読みの資格情報）。AI 作業版は App folder の `estimates/<原本の名前>_AI作業版.xlsx`（xlsm はそのまま xlsm）
- 1 回目は原本の写しに AI の tab を足して作る。2 回目からは AI 作業版に足す（Human がその写しに書いた物も残る）
- AI の tab：名前は `AI_` で始まる（例 `AI_案1`）。項目・仕様・数量・単位・単価・金額（=数量*単価）・備考と合計（=SUM）。値も入れる
- 直せるのは「台帳に AI が作ったと記録した `AI_` の tab」だけ（Human が `AI_` の名前を付けた tab も直さない）
- **保存の前の確かめ**：Human の tab の部品・画像・マクロ（vbaProject.bin）・styles・定義名・印刷設定・外部リンクは圧縮された bytes のまま 1 byte も同じ・workbook.xml 等は足した 1 行を除けば同じ。違えば保存しない（`xlsx_preserve_failed`）
- 上げる時は rev つき（Excel で開いて保存した直後などの同時の変更は conflict＝上書きしない）。上げる前の版は `business-backups/<business>/estimates/history/` に残す
- 扱えない file：古い `.xls`・パスワードつき・zip64 は止める（上書きしない）
- 原本からの移動：原本を変えずに移れる方法として、Grok の返事に AI 作業版の path を返す（原本にリンクを足す編集はしない）。App folder は原本と別の場所になる（書く資格情報を App folder に閉じ込めるための代わり）

## 7. 残る限界（受け入れ・記録）

- 読みの app は Full Dropbox の読み取り（Dropbox の scope はフォルダで絞れない）＝許可フォルダは code（scope.mjs）が強制。書けないことは資格情報が強制
- Dropbox の Smart Sync・オンラインのみの file は API で取るので関係しない。大きな file（64 MiB 超）は取らない
- AI 作業版・カルテは原本と別の場所（App folder）にある
- path は NFC にそろえて Dropbox へ送る（macOS から貼った NFD の名前も同じに比べる）。Dropbox が NFD のままの名前を別に扱う場合は `path_not_found`（止まる側）＝最初の実の読み取りで確かめる
- 見積の AI 作業版：台帳に書いた直後・上げる前に process が止まると、台帳に在って file に無い tab が残る（次の作成で名前の重複は拒否されるので、別の名前で作る）
- 独立監査（2026-11-13）：should-fix 11・nit 11 を直し、再検証で出た 4 件（閉じていない ai の印・# の値・calcChain の tag・sheetId の台帳）も直した
