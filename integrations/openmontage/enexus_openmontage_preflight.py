"""OpenMontage workflow -> E-NEXUS Decision Gateway の preflight wrapper（2026-09-26・MA-29 × MA-30）。

OpenMontage の workflow 成果物（proposal 段階の checkpoint）を入口にして、有料 tool を実行する前に
thin adapter（enexus_openmontage_decision.py）経由で Common Decision Gateway の paid-generation-gate を呼ぶ。

    OpenMontage workflow
      proposal 段階（manifest で human_approval_default: true）が
      <OPENMONTAGE_PROJECTS_DIR>/<project_id>/checkpoint_proposal.json を awaiting_human で書く
      （proposal_packet.production_plan.stages[].tools[] ＝ 使う tool・provider・見積）
      -> この wrapper（checkpoint を JSON として読むだけ。有料になりうる tool を拾って asset request にする）
      -> enexus_openmontage_decision.decide()（request を組む・Gateway を呼ぶ・typed result）
      -> Common Decision Gateway（local CLI・dev）-> Rules -> Decision Engine -> Human
      -> 報告（stdout / --out）。有料候補は /en-generate（MA-17：見積 -> Human-only 承認）への引き継ぎ候補

Decision Point がここである理由：
    OpenMontage では有料 tool の実行は assets 段階で起きる。assets 段階は proposal（Human gate）の後にしか進めない
    （lib/checkpoint.py の前段 checkpoint 検査）。proposal checkpoint が awaiting_human の間なら、どの有料 tool も
    まだ実行されていない。

絶対に守ること:
    - 判断ロジックを持たない（どの tool を Decision Point とみなすかの写像だけ持つ。route は Gateway が決める）
    - OpenMontage（AGPL-3.0）のコードを import しない・同梱しない。checkpoint を JSON として読むだけ（file contract）
    - OpenMontage の checkpoint / decision_log / project.json に書き込まない。human_approved を触らない
      （この報告は OpenMontage の proposal gate の承認でも、有料生成の承認でもない）
    - どの結果（tier=auto・route=en-generate-hub を含む）も承認ではない。有料生成は MA-17 の Human-only 承認だけ
    - OpenMontage 内蔵の有料 tool を実行させる出力を返さない
    - Gateway 呼び出しは 1 checkpoint あたり上限（既定 6）まで。超えた分は判定せず Human へ回す

CLI:
    python enexus_openmontage_preflight.py --project-dir <projects/<project_id>> --text
    python enexus_openmontage_preflight.py --checkpoint <checkpoint_proposal.json> [--json] [--out <report.json>]
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import enexus_openmontage_decision as om

WRAPPER_ID = "openmontage-preflight"
WRAPPER_VERSION = "1"
DEFAULT_MAX_CALLS = 6
GATE_STAGE = "proposal"
# proposal の後で有料 tool が実行されうる段階。これらの checkpoint が既にあれば「手遅れの可能性」を報告する
PAID_EXECUTION_STAGES = ("sample", "assets", "compose")

# OpenMontage の tool 名（tools/*.py の `name` / pipeline manifest の tools_available）-> capability
# 有料 provider に分岐しうる生成系 tool だけを Decision Point とする。合成・編集・解析系（video_compose /
# audio_mixer / color_grade / transcriber 等）は生成 API を呼ばないので対象外。
TOOL_CAPABILITY = {
    "video_selector": "video_generation",
    "image_selector": "image_generation",
    "tts_selector": "tts",
    "music_gen": "music_generation",
    "subtitle_gen": "subtitle",
    "atlas_3d": "3d_asset_generation",
    "fal_3d": "3d_asset_generation",
    "avatar_selector": "avatar",
    "lip_sync": "avatar",
}
# capability が直接書かれた tool 名（provider tool を直接指定した計画）も拾う
CAPABILITY_NAMES = set(TOOL_CAPABILITY.values()) | {"video_generation", "image_generation", "avatar", "character_animation"}


class CheckpointError(ValueError):
    """checkpoint が proposal gate の成果物として読めない"""


def load_checkpoint(path):
    p = Path(path)
    try:
        cp = json.loads(p.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise CheckpointError(f"checkpoint が見つかりません: {p.name}") from None
    except (ValueError, UnicodeDecodeError):
        raise CheckpointError(f"checkpoint を JSON として読めません: {p.name}") from None
    if not isinstance(cp, dict):
        raise CheckpointError("checkpoint が object ではありません")
    if cp.get("stage") != GATE_STAGE:
        raise CheckpointError(f"proposal 段階の checkpoint ではありません（stage={cp.get('stage')!r}）")
    packet = (cp.get("artifacts") or {}).get("proposal_packet")
    if not isinstance(packet, dict) or not isinstance(packet.get("production_plan"), dict):
        raise CheckpointError("proposal_packet.production_plan がありません")
    return cp


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 else None


def _capability(tool_name):
    if not isinstance(tool_name, str):
        return None
    if tool_name in TOOL_CAPABILITY:
        return TOOL_CAPABILITY[tool_name]
    return tool_name if tool_name in CAPABILITY_NAMES else None


def extract_candidates(checkpoint):
    """production_plan.stages[].tools[] と cost_estimate.line_items[] から Decision Point を拾う。

    戻り値: [{tool, capability, provider, pipeline_stage, role, estimated_cost_usd}]（(stage, tool, provider) で重複排除）
    """
    packet = checkpoint["artifacts"]["proposal_packet"]
    plan = packet["production_plan"]
    line_cost = {}
    for li in ((packet.get("cost_estimate") or {}).get("line_items") or []):
        if isinstance(li, dict) and isinstance(li.get("tool"), str) and _num(li.get("estimated_usd")) is not None:
            line_cost[li["tool"]] = line_cost.get(li["tool"], 0.0) + li["estimated_usd"]

    seen, out = set(), []
    for st in plan.get("stages") or []:
        if not isinstance(st, dict):
            continue
        for t in st.get("tools") or []:
            if not isinstance(t, dict):
                continue
            cap = _capability(t.get("tool_name"))
            if cap is None:
                continue
            key = (st.get("stage"), t["tool_name"], t.get("provider"))
            if key in seen:
                continue
            seen.add(key)
            est = _num(t.get("estimated_cost_usd"))
            out.append({
                "tool": t["tool_name"],
                "capability": cap,
                "provider": t.get("provider") if isinstance(t.get("provider"), str) else None,
                "pipeline_stage": st.get("stage") if isinstance(st.get("stage"), str) else None,
                "role": t.get("role") if isinstance(t.get("role"), str) else "",
                "estimated_cost_usd": est if est is not None else line_cost.get(t["tool_name"]),
            })
    # 計画の stages に無く見積だけにある生成系 tool（見積の書き方の揺れ）も拾う
    planned = {c["tool"] for c in out}
    for tool, cost in line_cost.items():
        cap = _capability(tool)
        if cap and tool not in planned:
            out.append({"tool": tool, "capability": cap, "provider": None, "pipeline_stage": None,
                        "role": "", "estimated_cost_usd": cost})
    return out


def to_asset_request(candidate, packet):
    """candidate -> adapter の asset request（構造情報だけ）。role は adapter が screening する"""
    plan = packet["production_plan"]
    promise = plan.get("delivery_promise") or {}
    req = {
        "capability": candidate["capability"],
        "purpose": candidate["role"] or f"{candidate['capability']} in OpenMontage {plan.get('pipeline', '')} pipeline",
        "style": promise.get("tone_mode"),
        "language": "ja",
        "tool": candidate["tool"],
        "pipeline_stage": candidate["pipeline_stage"],
    }
    if candidate.get("provider"):
        req["provider"] = candidate["provider"]
    if candidate.get("estimated_cost_usd") is not None:
        req["estimated_cost_usd"] = candidate["estimated_cost_usd"]
    # 手元素材が主役と明示された制作だけ true。それ以外は不明として送らない
    if promise.get("source_required") is True:
        req["has_local_assets"] = True
    return req


def later_stage_checkpoints(checkpoint_path):
    d = Path(checkpoint_path).parent
    return [s for s in PAID_EXECUTION_STAGES if (d / f"checkpoint_{s}.json").exists()]


def overall_verdict(decisions, not_evaluated, late):
    routes = [d["interpretation"]["route"] for d in decisions]
    if late or not_evaluated or "human-review" in routes or any(d["interpretation"]["status"] != "decided" for d in decisions):
        return "human-review"
    if "en-generate-hub" in routes:
        return "paid-handoff"
    if decisions:
        return "free-path"
    return "no-decision-point"


OVERALL_NEXT = {
    "human-review": "Human が判断する（判定が取れない／確認が必要／既に有料 tool 実行段階へ進んでいる可能性）。自動で進めない",
    "paid-handoff": "有料候補があります。該当 tool を OpenMontage 内で実行せず、/en-generate（MA-17：見積→Human-only承認）へ引き継ぐ",
    "free-path": "生成系 tool はすべて無料経路の候補です。OpenMontage の proposal gate は通常どおり Human が承認する",
    "no-decision-point": "生成系 tool の計画がありません（Gateway は呼んでいません）",
}


def run_preflight(checkpoint_path, env=None, max_calls=DEFAULT_MAX_CALLS, decide=None):
    """checkpoint 1 件を判定する。decide は test 用の差し替え口（既定は adapter.decide）"""
    decide = decide or om.decide
    cp = load_checkpoint(checkpoint_path)
    packet = cp["artifacts"]["proposal_packet"]
    late = later_stage_checkpoints(checkpoint_path)
    candidates = extract_candidates(cp)
    decisions, not_evaluated = [], []
    for c in candidates:
        if len(decisions) >= max_calls:
            not_evaluated.append({k: c[k] for k in ("tool", "capability", "provider", "pipeline_stage")})
            continue
        interpretation, _envelope = decide(to_asset_request(c, packet), env=env)
        decisions.append({
            "tool": c["tool"], "capability": c["capability"], "provider": c["provider"],
            "pipeline_stage": c["pipeline_stage"], "estimated_cost_usd": c["estimated_cost_usd"],
            "interpretation": interpretation,
        })
    verdict = overall_verdict(decisions, not_evaluated, late)
    handoff = [
        {"tool": d["tool"], "capability": d["capability"], "estimated_cost_usd": d["estimated_cost_usd"],
         "request_id": d["interpretation"].get("request_id"),
         "to": "/en-generate（MA-17）", "note": "OpenMontage 内でこの tool を実行しない。見積→Human-only 承認→run-approved"}
        for d in decisions if d["interpretation"]["route"] == "en-generate-hub"
    ]
    return {
        "wrapper": WRAPPER_ID,
        "wrapper_version": WRAPPER_VERSION,
        "decision_type": om.DECISION_TYPE,
        "openmontage_checkpoint": {
            "project_id": cp.get("project_id"),
            "stage": cp.get("stage"),
            "status": cp.get("status"),
            "pipeline_type": cp.get("pipeline_type"),
            "later_paid_stage_checkpoints": late,
        },
        "overall": verdict,
        "next_step": OVERALL_NEXT[verdict],
        "decisions": decisions,
        "not_evaluated": not_evaluated,
        "handoff_to_en_generate": handoff,
        "proceed_automatically": False,
        "openmontage_gate_touched": False,
        "paid_execution": om.PAID_EXECUTION,
        "openmontage_builtin_paid_tools": "forbidden",
    }


def format_text(r):
    c = r["openmontage_checkpoint"]
    lines = ["【E-NEXUS Decision Gateway：OpenMontage workflow の有料生成前チェック（proposal gate）】",
             f"project：{c['project_id']}／pipeline：{c['pipeline_type']}／checkpoint：{c['stage']}（{c['status']}）",
             f"総合：{r['overall']} — {r['next_step']}"]
    if c["later_paid_stage_checkpoints"]:
        lines.append(f"注意：proposal より後の段階の checkpoint が既にあります（{', '.join(c['later_paid_stage_checkpoints'])}）")
    for d in r["decisions"]:
        i = d["interpretation"]
        lines.append(f"- {d['tool']}（{d['capability']}・{d['provider'] or '-'}・見積 {d['estimated_cost_usd']} USD）→ route {i['route']}／tier {i.get('tier')}／"
                     f"Human確認 {'必要' if i['human_check'] else '経路判定としては不要'}／conf {i.get('confidence')}／request_id {i.get('request_id')}")
    for n in r["not_evaluated"]:
        lines.append(f"- {n['tool']}（{n['capability']}）→ 上限超過のため判定していません（Human が判断）")
    lines.append("※この結果は OpenMontage の proposal gate の承認でも、有料生成の承認でもありません。有料生成は必ず /en-generate（MA-17）の Human-only 承認を通ります。OpenMontage 内蔵の有料 tool は使いません。")
    return "\n".join(lines)


def _resolve_checkpoint(argv):
    if "--checkpoint" in argv:
        return Path(argv[argv.index("--checkpoint") + 1])
    if "--project-dir" in argv:
        return Path(argv[argv.index("--project-dir") + 1]) / f"checkpoint_{GATE_STAGE}.json"
    raise CheckpointError("--project-dir か --checkpoint を指定してください")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        cp_path = _resolve_checkpoint(argv)
        max_calls = int(argv[argv.index("--max-calls") + 1]) if "--max-calls" in argv else DEFAULT_MAX_CALLS
        # 引数の不備は Gateway を呼ぶ前に止める（拒否した呼び出しで判定・usage 記録を発生させない）
        out = Path(argv[argv.index("--out") + 1]) if "--out" in argv else None
        if out is not None and (out.name.startswith("checkpoint_") or out.name in ("decision_log.json", "project.json")):
            raise CheckpointError("OpenMontage の管理ファイル名へは書き込みません")
        report = run_preflight(cp_path, max_calls=max(0, max_calls))
    except (CheckpointError, IndexError, ValueError) as e:
        sys.stdout.buffer.write((json.dumps({"error": str(e), "overall": "human-review", "proceed_automatically": False}, ensure_ascii=False) + "\n").encode("utf-8"))
        return 2
    if out is not None:
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if "--text" in argv:
        sys.stdout.buffer.write((format_text(report) + "\n").encode("utf-8"))
    else:
        sys.stdout.buffer.write((json.dumps(report, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
