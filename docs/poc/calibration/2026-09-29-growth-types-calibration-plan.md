# 新 3 type の実 JEV Calibration 計画（2026-09-29・L07・**未実行＝Human の GO 待ち**）

対象：`automation-safety-gate`・`customer-reply-gate`・`lead-triage`（FB-04 で実働化・FB-15 で cases を用意）。
目的：Rules First に当たらないケースで Jev の confidence・tier・field ごとの限界・再抽選の一致率・敵対 holdout（注入文への追従）を実測し、閾値を据え置くか決める材料にする。**閾値の変更はこの run では行わない**（結果を見てから別に判断）。

## 何回・いくらか

| cases file | Rules First（送らない） | Jev へ送る | full の repeat | full の回数 |
|---|---|---|---|---|
| automation-safety-gate.cases | 8 | 4 | 5 | 20 |
| automation-safety-gate.holdout | 0 | 4 | 1 | 4 |
| automation-safety-gate.adversarial | 0 | 3 | 3 | 9 |
| customer-reply-gate.cases | 6 | 6 | 5 | 30 |
| customer-reply-gate.holdout | 0 | 4 | 1 | 4 |
| customer-reply-gate.adversarial | 0 | 3 | 3 | 9 |
| lead-triage.cases | 5 | 6 | 5 | 30 |
| lead-triage.holdout | 0 | 4 | 1 | 4 |
| lead-triage.adversarial | 0 | 3 | 3 | 9 |
| **計** | 19 | **37** | | **119** |

（`sh scripts/run-growth-calibration.sh --go <日付> --dry-run` の出力。ネットワーク無しで数えた値）

- 単価の根拠：第 3 回（2026-09-29 extended calibration）の実測 27,809 µUSD／243 回＝**約 114 µUSD／回**（上限側）。MCP 接続台帳の 64〜114 µUSD／判定とも合う
- **full＝最大 119 回・約 0.014 USD**／single（どれも×1）＝最大 37 回・約 0.0042 USD
- 常設の予算は無い（2026-09-29 第 3 回の「約 300 回・約 0.02 USD」の承認はその run 限定）。**この run の GO が要る**
- TypeSafe の残高はこちらから見ない（Secret・ダッシュボードはHuman）。0.02 USD 以上あれば足りる

## 止まる条件（再課金しない）

- runner：1 件目で 401／402／403／422／429 なら即停止・連続 unavailable で停止（`stopped` を結果に記録）
- wrapper：どこかの run が `stopped` を持ったら、以降の run を実行しない
- 前提の env（`JEV_API_KEY`・`JEV_PROVIDER=direct`・`EDL_ALLOW_NETWORK=true`）が無ければ exit 4 で何も送らない
- 2026-09-29 確認：この Windows PC の User env に 3 つとも present（値は見ていない）＝GO があれば AI がこのまま実行できる

## GO の後にやること（1 指示で完了）

Human の 1 行：「**L07 GO（full）**」または「**L07 GO（single）**」。AI は次を 1 回実行する（`EDL_ALLOW_NETWORK=true` はこのコマンドの process にだけ付け、User env・settings は変えない）：

```sh
JEV_PROVIDER=direct EDL_ALLOW_NETWORK=true sh scripts/run-growth-calibration.sh --go <GO の日> --plan full
```

その後 AI が：結果の要約（tier 分布・Human 率・注入追従・再抽選一致率・実費）を `docs/poc/calibration/<日付>-growth-types-calibration.md` に書き、閾値を据え置くか変えるかの提案を出す（変える場合は別の判断）。decision-log・MA-30 §18 に 1 行。

## やらないこと

- 閾値・schema・rules をこの run の途中で変えない
- 失敗した run を自動で再実行しない（`analyze` の merge で成功分を継ぎ足す機構を使い、再実行も Human の GO）
- `reordered`（選択肢の並び替え耐性）はこの計画に入れない（旧 3 type で実施済みの手法。必要なら別の GO）
