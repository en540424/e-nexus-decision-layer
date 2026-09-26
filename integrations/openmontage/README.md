# OpenMontage から使う（2026-09-26・MA-29 × MA-30）

OpenMontage（`<OpenMontage cloneのパス>`、MA-29 技術PoC成功・2026-09-18 に条件付き採用として記録・商品化判断は未決）の **有料生成の直前**で、
Common Decision Gateway の `paid-generation-gate` を呼ぶ thin consumer adapter。`application_id: openmontage`・PERSONAL / DEV のみ。

```
OpenMontage workflow（agent が有料 tool＝video_generation / image_generation 等の API tool を選びそうになった時点）
  → enexus_openmontage_decision.py（request を組む・Gateway を呼ぶ・typed result を返す）
  → Common Decision Gateway（local CLI `gateway decide --stdin`・environment=dev）→ Rules → Decision Engine → Human
  → route=local / remotion        ：OpenMontage の無料経路（手元素材・Remotion）で作る候補
    route=en-generate-hub         ：/en-generate（MA-17：見積 → Human-only 承認 → run-approved）へ引き継ぐ候補
    route=human-review / 取得失敗 ：Human が判断
```

## 置き場所の理由

- consumer adapter は本来 consumer 側に置くが、OpenMontage の clone は上流 `calesthio/OpenMontage`（AGPL-3.0）そのもので
  push 先が無く、E-NEXUS 固有のコードを上流へ混ぜない（Vault の管理台帳では class B・配布なし・上流の agent 契約を上書きしない扱い）。
  そのため Gateway repo の `integrations/`（claude-code / cursor / hermes と同列）に置く
- **OpenMontage のコードを import しない**（process 境界の外で動く独立 adapter。AGPL の範囲を E-NEXUS 側へ広げない。
  入力は caller が渡す構造情報だけ）。OpenMontage の tracked files（`AGENT_GUIDE.md` 等）も編集しない
- stdlib のみ（Python 3.10+）。Gateway 呼び出しには `node` が要る

## workflow から使う（preflight wrapper・推奨）

OpenMontage では有料 tool の実行は assets 段階で起き、assets は proposal 段階（pipeline manifest で `human_approval_default: true`）の
Human gate の後にしか進めない。proposal 段階は `<OPENMONTAGE_PROJECTS_DIR>/<project_id>/checkpoint_proposal.json` を
`awaiting_human` で書き、`proposal_packet.production_plan.stages[].tools[]` に使う tool・provider・見積が入る。
**この checkpoint が `awaiting_human` の間に** preflight を実行する（どの有料 tool もまだ実行されていない）。

```
OpenMontage workflow（proposal 段階 → checkpoint_proposal.json・awaiting_human）
  → enexus_openmontage_preflight.py（checkpoint を JSON で読むだけ・生成系 tool ごとに adapter を呼ぶ・上限 6 回）
  → enexus_openmontage_decision.py → Common Decision Gateway（dev）→ Rules → Decision Engine → Human
  → overall: free-path / paid-handoff / human-review / no-decision-point
```

```bash
python <e-nexus-decision-layerのパス>/integrations/openmontage/enexus_openmontage_preflight.py --project-dir <OpenMontageのprojects>/<project_id> --text
python .../enexus_openmontage_preflight.py --checkpoint <checkpoint_proposal.json> --out <report.json>   # JSON 報告を保存
```

- `paid-handoff`：`handoff_to_en_generate` の tool を OpenMontage 内で実行せず、/en-generate（MA-17）で見積→Human-only 承認へ
- `human-review`：判定不能・呼び出し上限超過・proposal より後（sample / assets / compose）の checkpoint が既にある（手遅れの可能性）
- 報告は OpenMontage の proposal gate の承認ではない。checkpoint・`decision_log.json`・`project.json`・`human_approved` には書かない
  （`--out` にこれらの名前は指定できない）
- Decision Point とみなす tool は生成系だけ（`video_selector`・`image_selector`・`tts_selector`・`music_gen`・`subtitle_gen`・3D・avatar 等）。
  合成・編集・解析（`video_compose`・`audio_mixer`・`color_grade`・`transcriber` 等）は呼ばない。route は Gateway が決める
- Engine へ送る `purpose` は tool の `role`（adapter が 200 字・パス伏せ・PII/key 風なら送らない）。**role に人物名・顧客名を書かない**
- OpenMontage の agent が自分でこの wrapper を呼ぶには上流の `AGENT_GUIDE.md` 等への追記が要る（上流は編集しない・Human 判断）。
  現在は OpenMontage を動かしている Claude Code セッション（Vault 起点・Skill `enexus-decision`）が proposal gate で実行する

## adapter を直接使う

```bash
python <e-nexus-decision-layerのパス>/integrations/openmontage/enexus_openmontage_decision.py --text < asset-request.json
```

asset request（OpenMontage workflow が組む構造情報。`tool.estimate_cost()` / `dry_run()` の値を使ってよい）：

```json
{
  "capability": "video_generation",
  "purpose": "製品紹介の導入カット（5秒・動きのある実写風）",
  "style": "photoreal",
  "duration_sec": 5,
  "has_reference_media": false,
  "has_local_assets": false,
  "estimated_cost_usd": 0.35,
  "language": "ja",
  "tool": "kling_video", "provider": "fal", "pipeline_stage": "assets"
}
```

- Decision Engine へ送るのは `input`（asset_kind・purpose・style・duration・参照/手元素材の有無・見積 micros・language）だけ。
  `tool` / `provider` / `model` / `pipeline_stage` は `context`（Engine へ送られない）
- `purpose` は 200 字で切り、ローカルパスを伏せ、メール・電話番号・key 風の文字列があれば 1 文字も送らない。
  **人物名・顧客名・prompt 全文は caller が入れない**（adapter は人物名を検出できない）
- 出力の `route` / `next_step` / `tier` / `human_check` / `confidence` / `external_engine_reached` / `request_id` / `environment` を読む。
  `proceed_automatically` は常に `false`、`openmontage_builtin_paid_tools` は常に `forbidden`

## 守ること

- **どの結果（tier=auto・route=en-generate-hub を含む）も承認ではない。** 有料生成は /en-generate の MA-17 Human-only 承認だけが許可する
- OpenMontage 内蔵の有料 tool（fal / kling / runway / veo 等の API tool）を直接実行しない（MA-29 Human判断 2026-09-17）
- local CLI transport は `dev` のみ。一般販売・外部ユーザー向けの経路にしない（`docs/gateway.md` §12）

## テスト

```bash
cd integrations/openmontage   # repo ルートから
python -m unittest discover -s . -p "test_*.py"
```

preflight の test（`test_enexus_openmontage_preflight.py`）は `fixtures/` の合成 checkpoint（E-NEXUS 作成・OpenMontage の
schema やコードは同梱しない）を使い、OpenMontage の clone が無くても通る。

transport は `consumer-kit/conformance/transport-cases.json`（Node reference と同じ cases）を fake Gateway 相手に全件通す。
実 Decision Engine は呼ばない（実 Gateway 往復はネットワーク無し・usage は tmp）。
