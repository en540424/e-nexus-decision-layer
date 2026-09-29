# TypeSafe Direct 正式化・Vercel 経路廃止（2026-09-29）— 準備完了／Human 操作待ち

発注：「TypeSafe Direct 正式化・Vercel 経路廃止」（2026-09-29 Human）。
正式経路は **E-NEXUS → Common Decision Gateway → TypeSafe Direct API → Jev**。Vercel AI Gateway は Direct が使えるまでの暫定経路だった。
Contract v1・chain・閾値 0.85 / 0.60・Human-only・MA-17・failure policy（fail-closed）は変えない。consumer のコードも変えない。

## 1. 現在地

| 項目 | 状態 |
|---|---|
| 公式仕様の再確認（2026-09-29） | `POST https://api.typesafe.ai/v1/systemone`・`Authorization: Bearer`・request `{model, state, questions}`・noul / choice / score・応答 `model` は実際に答えた版（`jev-1.13.0`、`jev-latest` / `jev-preview` は alias）・choice / score は `probabilities` と `confidence`・score は `legend`・エラー 401 / 422 / 429 / 529・課金は入力 token のみ（$42/Btok 公表値）・rate limit 1,200 req/min（公表値）。鍵は `console.typesafe.ai/keys`。トップページは Jev を「early access」と表記。一次情報：docs.typesafe.ai `llms.txt`・`api.md`・`models.md`・`introduction/quickstart.md`・`primitives/choice.md` |
| endpoint の到達性 | 鍵なし・本文なしの GET で `405`（POST 専用の endpoint が生きている）。データは送っていない |
| Direct provider | 実装済み。今回 403→`JEV_FORBIDDEN`・402→`JEV_PAYMENT_REQUIRED`・400→`JEV_REQUEST_REJECTED`（いずれも再試行しない）を追加（master `b4dd548`） |
| Calibration runner | provider 非依存化（vercel provider を import しない）。403 / 402 / 422 / provider 不明で 1 件目停止（master `b4dd548`） |
| Vercel 経路の削除 | **branch `direct-only-cutover` に準備済み・未 merge**。tests 271/271・OpenMontage Python 97/97 |
| Direct 実疎通 | **未実施**。このPCのどの scope にも `JEV_API_KEY` が無い（Process / User / Machine を名前だけ確認。値は見ていない）。鍵の発行は認証が要る管理画面（console.typesafe.ai）で、AI は開かない |
| 現在の実 JEV | 到達不能のまま（User env は `JEV_PROVIDER=vercel`・Vercel は 403）。全 consumer は fail-closed で human tier へ倒れる |

## 2. Human Required（1 回で済む形）

1. `console.typesafe.ai` にログインし、API を使えるか（early access の有効化）を確認して、API キーを 1 本発行する
2. そのキーを **Windows の User 環境変数 `JEV_API_KEY`** に設定する（公式 SDK の名前 `TYPESAFE_API_KEY` ではなく `JEV_API_KEY`。engine-env manifest と OpenMontage Launcher の除去対象がこの名前で動いている）。チャット・ファイルに貼らない
3. 同じ画面で User 環境変数 **`JEV_PROVIDER` を `direct`** に変える（削除でもよい。未設定は `direct`）
4. Windows のサインアウト／サインイン 1 回（Claude Code と常駐 watcher が新しい env を持つ。§18-13 と同じ）
5. Claude Code で「Direct smoke から再開して」と言う

鍵の保管場所は `AI_GATEWAY_API_KEY` と同じ扱い（Decision Engine 用の鍵は User env。MA-30 §18-13 で「対象外」とした判断をそのまま引き継ぐ。資格情報マネージャー化は今回しない）。

任意（Direct 成功の後）：User env から `AI_GATEWAY_API_KEY` を削除・Vercel ダッシュボードでキーを失効／`.env.example` の Vercel 節の削除（`.env*` は Claude Code の機械ガードで編集拒否のため Human 作業）。

## 3. 再開手順（Claude Code・Human 操作の後）

1. env 確認（名前と有無だけ）：`JEV_API_KEY` present・`JEV_PROVIDER=direct`・`EDL_ALLOW_NETWORK=true`
2. `node src/cli.mjs gateway health` → `jev.usable: true`・`provider: direct`
3. **Direct smoke 1 件**（master のまま・Vercel はまだ残っている状態）：
   `node scripts/poc-calibration.mjs run --questions improved --cases docs/poc/calibration/paid-generation-gate.v2.cases.json --only PG-J1-local-crop-existing-photos --label cal3-direct-smoke`
   合格＝record の `jev.status ok`・`route direct`・`input_tokens > 0`・`model_version`（例 `jev-1.13.0`）・`probabilities` あり。401 / 402 / 403 なら runner は 1 件で止まる → 理由を Human へ返す（鍵・early access・課金）。
   **422（`JEV_REQUEST_REJECTED`）は Human の問題ではなくコード側の可能性が高い**（noul criteria・choice の null criteria は実疎通で未検証）。`details.problem`（どの field か）を見て AI 側で直す
4. **Vercel 廃止を確定**：`git merge --no-ff direct-only-cutover` → `npm test`（271）＋ OpenMontage Python（`integrations/openmontage` で `python -m unittest discover -p "test_*.py"`・97）→ push
5. **S5 拡張 Calibration**（Direct 経路）：`2026-09-29-extended-calibration.md` §2 の 9 コマンド（約 243 回。過去実測は 1 回あたり入力 約 900〜1,800 token なので合計 約 36 万 token 前後＝公表値 $0.042/Mtok で 約 0.015 USD。出力は無料）→ §3 の analyze。閾値は変えず、結果を Human 判断材料として記録する
6. Vault：MA-30 §18-15・台帳・技術スタック台帳 §2-12・Skill `enexus-decision` §3・開発ログを更新

## 4. branch `direct-only-cutover` の中身

- 削除：`src/adapters/jev/jev-vercel-provider.mjs`・`tests/jev-vercel-provider.test.mjs`（20 件。消えるコードだけの検査）・`optionalDependencies.ai`（lock 縮小）・`index.mjs` の export・provider registry / `JEV_PROVIDER_IDS` の `vercel`
- engine-env manifest の `forward` から `AI_GATEWAY_API_KEY`・`AI_GATEWAY_BASE_URL`・`JEV_VERCEL_MODEL`・`JEV_ZDR` を外し、新設の `withhold.names` へ移す（Gateway へは渡さないが、OpenMontage Launcher は agent の子 env から外し続ける。forward から消しただけだと Launcher の除去対象からも消え、User env に残る `AI_GATEWAY_API_KEY` が agent へ渡る回帰を Python test が検出したため。en-sns-hub / en-generate-hub の `buildChildEnv` はこの manifest で `JEV_API_KEY`・`JEV_PROVIDER` だけを渡し、`AI_GATEWAY_API_KEY`・有料鍵は渡さないことを確認済み。consumer のコード変更なし）
- `JEV_PROVIDER=vercel` が残っていても direct へ読み替えない（`JEV_PROVIDER_UNKNOWN` → human）。**merge の前に User env の `JEV_PROVIDER` を `direct` にしておくこと**
- vercel を route の代役にしていた検査は Direct（`fetchImpl` 注入・api.md 形の応答）へ移し、assertion を維持した
- tests：master 291 → branch 271（-20 vercel 専用、jev-model-evidence 7→5、gateway-real-jev-path 9→10（403 を追加）、gateway-engine-env +1（withhold））。OpenMontage Python 96 → 97（withhold）
- 残すもの：OpenMontage Launcher・en-generate-hub `secret-boundary-probe.ps1` の `AI_GATEWAY_API_KEY` 除去／検査（§18-13 の多層防御。User env に鍵が残る間は意味がある）、runner の Secret 混入検査対象、過去の calibration 結果・usage.jsonl の `route: vercel` 行（履歴）

## 5. 実鍵がある状態で tests が実送信しないことの確認（2026-09-29）

Direct は依存無しで `fetch` が常に使えるため、`process.env` を読む test があれば Human が実鍵を入れた後の `npm test` で実送信・課金・本番 usage 書き込みが起きる。
`JEV_PROVIDER=direct`・`JEV_API_KEY=dummy-not-real`・`EDL_ALLOW_NETWORK=true`・`JEV_API_BASE_URL=http://127.0.0.1:<port>`（受信を記録するだけのローカル sink）で次を実行し、
**sink への `POST /v1/systemone` 0 件・本番 `data/usage/usage.jsonl` の行数不変（221）**を確認した：decision-layer master（291）・branch（271）・en-sns-hub 全体（53・Gateway CLI を実起動）・
en-generate-hub decision-gate（14）・OpenMontage Python（master 96／branch 97）。sink には Cursor のローカルポート自動検知（`GET /`・`/json/version`）だけが届いた（tests 由来ではない）。
