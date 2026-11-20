# 見積PDFの検索・取得と印刷ページ変換

## ローカルTask Hub

- `dropbox.pdf.search` は `human-cli` 専用。事業区分ごとに、承認済みの `dropbox.businesses.<business>.pdf_roots` が必要。ファイル名で検索して、正規化したパスと既存の拒否パス・拒否語で候補を絞る。候補が1件でも自動選択しない。
- `dropbox.pdf.fetch` はパスと候補のリビジョンを指定し、既存のHuman承認を経て実行。ダウンロードしたファイルのパス、リビジョン、Dropboxのコンテンツハッシュを確認する。PDFはMacの事業別バックアップ領域にある `pdf-staging` に0600で保存する。結果にはローカル参照とサイズのみを含める。
- `pdf_roots` の追加は別承認。保護資料が混在する上位フォルダは登録しない。既存の `read_only` はDropbox出力とバックアップを引き続き制限する。設定を入れない限りPDF検索と取得は休止する。
- 現在のVPSは16 KiBまでの状態・結果JSONのみを受け付ける。コードの既定保持期間は依頼7日、結果14日。本番VPSの実設定とGrok側の保持期間は別途確認する。PDFはVPSへ送られない。Macのステージングの自動削除・遠隔返却は未実装であり、機密PDFの本番利用開始には保管方法の確定が必要。

## Excel印刷ページのローカル変換

`estimate-pages.py` は試験用または個別に許可されたローカルXLSXを処理する。入力Excelを一時コピーし、LibreOffice 26.8以降のシート範囲指定で印刷結果を作成する。ページ番号はタブ単位で1から始まる。選択した順に一つのPDFにまとめ、各ページの確認文字列と、再読込した出力の枚数を検査する。確認文字列が印刷結果にない場合は出力を作らない。見つからないページ、外部参照・マクロを含む入力、既存出力への上書きは拒否する。

```sh
python3 scripts/lib/pdf/estimate-pages.py estimate.xlsx selection.json output.pdf
```

```json
[{"sheet":"表紙","page":1,"expected_text":"見積番号 A123"},{"sheet":"詳細","page":1,"expected_text":"項目A"},{"sheet":"詳細","page":2,"expected_text":"項目B"}]
```

Pythonのlxmlとpypdf、LibreOfficeが必要。試験データで順序、計算値、原本のバイト不変性、存在しないページの拒否を確認。実際のExcelとLibreOfficeの印刷差（フォント、改ページ、倍率、書式など）は残る。Macの試験環境では標準の模擬ブックで一部の日本語字形が描画されなかった。承認済みひな形と元の印刷結果による照合と、無人実行の隔離・レイアウト確認を終えるまでは本番の自動返却に使わない。
