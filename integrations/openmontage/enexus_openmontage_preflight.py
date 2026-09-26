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
    proposal 段階を持たない pipeline（13 中 9：talking-head / hybrid / avatar-spokesperson 等。2026-09-26 時点の
    pipeline_defs）では、assets の直前の Human gate は scene_plan。その project に checkpoint_proposal.json が無いときだけ
    checkpoint_scene_plan.json（scenes[].required_assets[] のうち source=generate）を Decision Point にする。

自動実行（2026-09-26〜）：
    enexus_openmontage_launcher.py が OpenMontage の projects/ を監視し、gate checkpoint を検知したらこの wrapper を
    自動で呼ぶ（Human / agent が wrapper を覚えて手で呼ぶ必要はない）。この CLI は手動の再実行・調査用に残す。

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

import hashlib
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import enexus_openmontage_decision as om

WRAPPER_ID = "openmontage-preflight"
WRAPPER_VERSION = "2"
DEFAULT_MAX_CALLS = 6
GATE_STAGE = "proposal"
# proposal を持たない pipeline の gate（proposal が無い project でだけ使う）
FALLBACK_GATE_STAGE = "scene_plan"
GATE_STAGES = (GATE_STAGE, FALLBACK_GATE_STAGE)
# gate の後で有料 tool が実行されうる段階。これらの checkpoint が既にあれば「手遅れの可能性」を報告する
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


def validate_gate_checkpoint(cp, stages=GATE_STAGES):
    """parse 済み checkpoint が gate の成果物として読めるか（OpenMontage の checkpoint schema の field だけを使う）"""
    if not isinstance(cp, dict):
        raise CheckpointError("checkpoint が object ではありません")
    stage = cp.get("stage")
    if stage not in stages:
        raise CheckpointError(f"gate（{' / '.join(stages)}）段階の checkpoint ではありません（stage={stage!r}）")
    artifacts = cp.get("artifacts") or {}
    if stage == GATE_STAGE:
        packet = artifacts.get("proposal_packet")
        if not isinstance(packet, dict) or not isinstance(packet.get("production_plan"), dict):
            raise CheckpointError("proposal_packet.production_plan がありません")
    else:
        plan = artifacts.get("scene_plan")
        if not isinstance(plan, dict) or not isinstance(plan.get("scenes"), list):
            raise CheckpointError("scene_plan.scenes がありません")
    return cp


def parse_checkpoint_bytes(data, name="checkpoint", stages=GATE_STAGES):
    try:
        cp = json.loads(data.decode("utf-8") if isinstance(data, bytes) else data)
    except (ValueError, UnicodeDecodeError):
        raise CheckpointError(f"checkpoint を JSON として読めません: {name}") from None
    return validate_gate_checkpoint(cp, stages)


def load_checkpoint(path, stages=GATE_STAGES):
    p = Path(path)
    try:
        data = p.read_bytes()
    except FileNotFoundError:
        raise CheckpointError(f"checkpoint が見つかりません: {p.name}") from None
    return parse_checkpoint_bytes(data, p.name, stages)


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0 else None


def _capability(tool_name):
    if not isinstance(tool_name, str):
        return None
    if tool_name in TOOL_CAPABILITY:
        return TOOL_CAPABILITY[tool_name]
    return tool_name if tool_name in CAPABILITY_NAMES else None


def extract_candidates(checkpoint):
    """gate checkpoint から Decision Point（有料生成になりうる生成系の需要）を拾う。stage で読み方を切り替える"""
    if checkpoint.get("stage") == FALLBACK_GATE_STAGE:
        return _extract_scene_plan_candidates(checkpoint)
    return _extract_proposal_candidates(checkpoint)


# scene_plan の required_assets[].type（自由文字列）-> capability。無い type は unclassified（asset_kind=other で判定する）
ASSET_TYPE_CAPABILITY = {
    "image": "image_generation", "still": "image_generation", "photo": "image_generation", "illustration": "image_generation",
    "background": "image_generation", "thumbnail": "image_generation",
    "video": "video_generation", "clip": "video_generation", "footage": "video_generation", "b-roll": "video_generation",
    "broll": "video_generation", "b_roll": "video_generation", "animation": "video_generation",
    "music": "music_generation", "bgm": "music_generation",
    "narration": "tts", "voiceover": "tts", "voice": "tts", "tts": "tts", "speech": "tts",
    "subtitle": "subtitle", "subtitles": "subtitle", "caption": "subtitle", "captions": "subtitle",
    "avatar": "avatar", "talking_head": "avatar", "talking-head": "avatar", "lip_sync": "avatar",
    "3d": "3d_asset_generation", "model_3d": "3d_asset_generation",
}
UNCLASSIFIED_CAPABILITY = "unclassified_generation"


def _extract_scene_plan_candidates(checkpoint):
    """scene_plan.scenes[].required_assets[]（source=generate）を capability ごとに 1 件へまとめる。

    tool は未定（scene_plan 時点では selector を選んでいない）なので tool=None・見積なし。purpose は scene の description
    （先頭 2 件）で、adapter が 200 字・パス伏せ・PII/key 風なら送らない screening をかける。
    """
    plan = checkpoint["artifacts"]["scene_plan"]
    groups = {}
    for sc in plan.get("scenes") or []:
        if not isinstance(sc, dict):
            continue
        dur = None
        s0, s1 = _num(sc.get("start_seconds")), _num(sc.get("end_seconds"))
        if s0 is not None and s1 is not None and s1 >= s0:
            dur = s1 - s0
        for ra in sc.get("required_assets") or []:
            if not isinstance(ra, dict) or ra.get("source") != "generate":
                continue
            atype = str(ra.get("type") or "").strip().lower()
            cap = ASSET_TYPE_CAPABILITY.get(atype, UNCLASSIFIED_CAPABILITY)
            g = groups.setdefault(cap, {"count": 0, "duration": 0.0, "descs": [], "types": set()})
            g["count"] += 1
            g["types"].add(atype or "unspecified")
            if dur is not None:
                g["duration"] += dur
            desc = ra.get("description") or sc.get("description")
            if isinstance(desc, str) and desc.strip() and len(g["descs"]) < 2:
                g["descs"].append(desc.strip())
    out = []
    for cap, g in groups.items():
        purpose = f"scene_plan: {'/'.join(sorted(g['types']))} x{g['count']}"
        if g["descs"]:
            purpose += "（例：" + "／".join(g["descs"]) + "）"
        out.append({
            "tool": None, "capability": cap, "provider": None, "pipeline_stage": "assets", "role": purpose,
            "estimated_cost_usd": None,
            "duration_sec": round(g["duration"], 3) if g["duration"] and cap in ("video_generation", "tts", "music_generation", "avatar") else None,
            "style": None, "has_local_assets": None,
        })
    return out


def _extract_proposal_candidates(checkpoint):
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


def to_asset_request(candidate, packet=None):
    """candidate -> adapter の asset request（構造情報だけ）。role は adapter が screening する。

    packet は proposal の proposal_packet（scene_plan の candidate では None）。
    """
    plan = (packet or {}).get("production_plan") or {}
    promise = plan.get("delivery_promise") or {}
    req = {
        "capability": candidate["capability"],
        "purpose": candidate["role"] or f"{candidate['capability']} in OpenMontage {plan.get('pipeline', '')} pipeline",
        "style": candidate.get("style") or promise.get("tone_mode"),
        "language": "ja",
        "pipeline_stage": candidate["pipeline_stage"],
    }
    if candidate.get("tool"):
        req["tool"] = candidate["tool"]
    if candidate.get("provider"):
        req["provider"] = candidate["provider"]
    if candidate.get("estimated_cost_usd") is not None:
        req["estimated_cost_usd"] = candidate["estimated_cost_usd"]
    if candidate.get("duration_sec") is not None:
        req["duration_sec"] = candidate["duration_sec"]
    # 手元素材が主役と明示された制作だけ true。それ以外は不明として送らない
    if candidate.get("has_local_assets") is True or promise.get("source_required") is True:
        req["has_local_assets"] = True
    return req


def _packet(checkpoint):
    return (checkpoint.get("artifacts") or {}).get("proposal_packet") if checkpoint.get("stage") == GATE_STAGE else None


def asset_requests(checkpoint):
    """gate checkpoint -> [(candidate, asset request)]"""
    packet = _packet(checkpoint)
    return [(c, to_asset_request(c, packet)) for c in extract_candidates(checkpoint)]


def plan_identity(checkpoint):
    """判定に効く内容だけの digest。

    OpenMontage は書くたびに timestamp を更新し、Human 承認（awaiting_human -> completed）でも同じ file を書き直す。
    file の bytes ではなく「Engine へ送る asset request の集合」で同一性を決めるので、承認・再保存では再判定せず、
    計画（tool・provider・見積・役割・scene 需要）が変わったときだけ再判定する。
    """
    reqs = sorted(json.dumps(r, sort_keys=True, ensure_ascii=False) for _c, r in asset_requests(checkpoint))
    doc = {"project_id": checkpoint.get("project_id"), "stage": checkpoint.get("stage"), "requests": reqs}
    return hashlib.sha256(json.dumps(doc, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


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
    "free-path": "生成系の需要はすべて無料経路の候補です。OpenMontage の gate（proposal / scene_plan）は通常どおり Human が承認する",
    "no-decision-point": "生成系の計画がありません（Gateway は呼んでいません）",
}


def run_preflight(checkpoint_path, env=None, max_calls=DEFAULT_MAX_CALLS, decide=None, max_workers=1):
    """checkpoint 1 件を判定する。decide は差し替え口（既定は adapter.decide。launcher は retry / 同時実行制御を挟む）"""
    return run_preflight_checkpoint(load_checkpoint(checkpoint_path), checkpoint_path, env=env, max_calls=max_calls,
                                    decide=decide, max_workers=max_workers)


def run_preflight_checkpoint(cp, checkpoint_path, env=None, max_calls=DEFAULT_MAX_CALLS, decide=None, max_workers=1):
    """parse・検証済みの checkpoint を判定する（launcher は読んだ bytes を二度読みしない）。

    max_workers>1 なら candidate を並列に判定する（結果の順序は計画の順のまま）。同時実行の上限は decide 側で持つ。
    """
    decide = decide or om.decide
    validate_gate_checkpoint(cp)
    late = later_stage_checkpoints(checkpoint_path)
    pairs = asset_requests(cp)
    todo, not_evaluated = pairs[:max_calls], pairs[max_calls:]

    def one(pair):
        c, req = pair
        interpretation, _envelope = decide(req, env=env)
        return {
            "tool": c["tool"], "capability": c["capability"], "provider": c["provider"],
            "pipeline_stage": c["pipeline_stage"], "estimated_cost_usd": c["estimated_cost_usd"],
            "interpretation": interpretation,
        }

    if max_workers > 1 and len(todo) > 1:
        with ThreadPoolExecutor(max_workers=min(max_workers, len(todo))) as ex:
            decisions = list(ex.map(one, todo))
    else:
        decisions = [one(p) for p in todo]
    not_evaluated = [{k: c[k] for k in ("tool", "capability", "provider", "pipeline_stage")} for c, _r in not_evaluated]
    verdict = overall_verdict(decisions, not_evaluated, late)
    handoff = [
        {"tool": d["tool"], "capability": d["capability"], "estimated_cost_usd": d["estimated_cost_usd"],
         "request_id": d["interpretation"].get("request_id"),
         "to": "/en-generate（MA-17）", "note": "OpenMontage 内でこの tool / 生成を実行しない。見積→Human-only 承認→run-approved"}
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
            "timestamp": cp.get("timestamp"),
            "plan_identity": plan_identity(cp),
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
    lines = [f"【E-NEXUS Decision Gateway：OpenMontage workflow の有料生成前チェック（{c['stage']} gate）】",
             f"project：{c['project_id']}／pipeline：{c['pipeline_type']}／checkpoint：{c['stage']}（{c['status']}）／timestamp：{c.get('timestamp')}",
             f"総合：{r['overall']} — {r['next_step']}"]
    if c["later_paid_stage_checkpoints"]:
        lines.append(f"注意：gate より後の段階の checkpoint が既にあります（{', '.join(c['later_paid_stage_checkpoints'])}）")
    for d in r["decisions"]:
        i = d["interpretation"]
        lines.append(f"- {d['tool'] or '(tool 未定)'}（{d['capability']}・{d['provider'] or '-'}・見積 {d['estimated_cost_usd']} USD）→ route {i['route']}／tier {i.get('tier')}／"
                     f"Human確認 {'必要' if i['human_check'] else '経路判定としては不要'}／conf {i.get('confidence')}／request_id {i.get('request_id')}")
    for n in r["not_evaluated"]:
        lines.append(f"- {n['tool'] or '(tool 未定)'}（{n['capability']}）→ 上限超過のため判定していません（Human が判断）")
    lines.append("※この結果は OpenMontage の gate の承認でも、有料生成の承認でもありません。有料生成は必ず /en-generate（MA-17）の Human-only 承認を通ります。OpenMontage 内蔵の有料 tool は使いません。")
    return "\n".join(lines)


def _resolve_checkpoint(argv):
    if "--checkpoint" in argv:
        return Path(argv[argv.index("--checkpoint") + 1])
    if "--project-dir" in argv:
        d = Path(argv[argv.index("--project-dir") + 1])
        # proposal があればそれが gate。無い pipeline は scene_plan
        for stage in GATE_STAGES:
            if (d / f"checkpoint_{stage}.json").exists():
                return d / f"checkpoint_{stage}.json"
        return d / f"checkpoint_{GATE_STAGE}.json"
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
