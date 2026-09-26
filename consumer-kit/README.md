# E-NEXUS Consumer Integration Kit（v1・2026-09-26）

新しい App / SaaS / Agent を Common Decision Gateway へつなぐときに、毎回作り直さないための最小セット。
**標準（手順・責務・環境・privacy）の本文は `docs/gateway.md` §9**。ここには部品だけを置く。

| パス | 中身 | 使い方 |
|---|---|---|
| `conformance/transport-cases.json` | local CLI transport の言語非依存 conformance cases（正常・環境不一致・環境欠落・Gateway error・不正 stdout・非 v1・crash・timeout・env allowlist 3 profile・設定不備） | どの言語の adapter も、自分の test でこの全 case を通す |
| `conformance/fake-gateway/` | cases を返す fake Gateway（`EDL_HOME` に指定し、`EDL_FAKE_CASE` で case を選ぶ）。外部通信・書き込みなし | adapter の test から子 process として起動 |
| `node/cli-transport.mjs` | Node の reference transport（en-generate-hub・en-sns-hub の重複実装から抽出） | 新しい Node consumer はコピーして持つ（repo をまたぐ runtime import はしない） |

Python の実装例は `integrations/openmontage/enexus_openmontage_decision.py`（同じ cases を通す）。
2 つ目の Python consumer（Hermes 等）が出た時点で、その transport 部分をここへ移す候補にする。

入れないもの：Decision Engine 固有の名前（env 名・endpoint・provider id）、decision_type 固有の input builder・outcome 正規化、
承認・実行・課金の経路、HTTP / Production 用 transport（Production Gateway は未構築・Human Required）。
