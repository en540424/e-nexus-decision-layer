"""OpenMontage -> E-NEXUS Common Decision Gateway の thin consumer adapter（2026-09-26・MA-29 × MA-30）。

位置づけ（repo docs/gateway.md §9 / Vault Decision Layer 正本 §18）:
    OpenMontage workflow（agent が有料 tool を選びそうになった時点）
      -> この adapter（paid-generation-gate の request を組む・Gateway を呼ぶ・typed result を返す）
      -> Common Decision Gateway（local CLI `gateway decide --stdin`・PERSONAL / DEV）
      -> Decision Layer -> Rules -> Decision Engine -> Human
      -> route=en-generate-hub なら /en-generate（MA-17：見積 -> Human-only 承認 -> run-approved）へ引き継ぐ

絶対に守ること:
    - 判断ロジックを持たない（schema / rules / Decision Engine が持つ）。Decision Engine を直接呼ばない・その固有名を持たない
    - どの結果（tier=auto を含む）も承認ではない。有料生成は MA-17 の Human-only 承認だけが許可する
    - OpenMontage 内蔵の有料 tool（video_generation / image_generation 等の API tool）を直接実行させる出力を返さない
    - OpenMontage（AGPL-3.0）のコードを import しない。入力は caller が渡す構造情報だけ（process 境界の外で動く独立 adapter）
    - stdlib のみ。Engine へ送る input に Secret・PII・prompt 全文・ローカルパス・人物名を入れない

transport 契約は consumer-kit/conformance/transport-cases.json（言語非依存）に従う。Node の reference 実装は
consumer-kit/node/cli-transport.mjs。

CLI:
    python enexus_openmontage_decision.py < asset-request.json         # interpretation を JSON で出力
    python enexus_openmontage_decision.py --json < asset-request.json  # envelope も含める
    python enexus_openmontage_decision.py --text < asset-request.json  # 日本語の要約
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

KIT_VERSION = "1"
CONTRACT_VERSION = "1"
APPLICATION_ID = "openmontage"
PROJECT_ID = "openmontage"
DECISION_TYPE = "paid-generation-gate"
DEFAULT_TIMEOUT_S = 35.0  # Gateway 自身の 30s より長くし、構造化 envelope（GATEWAY_TIMEOUT）を先に受け取る
RUNTIME_ENVIRONMENTS = ("dev", "staging", "production")
LOCAL_TRANSPORT_ENVIRONMENTS = ("dev",)
ENGINE_ENV_MANIFEST = Path("policies") / "gateway" / "engine-env.json"
OS_ENV_KEYS = ("PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "USERPROFILE", "HOME", "LANG")
GATEWAY_NAMESPACE_PREFIX = "EDL_"
# OpenMontage 側 provider の Secret。Gateway の manifest に何が書かれていても子 process へ渡さない（多層防御）
NEVER_FORWARD = re.compile(
    r"^(FAL_|WAVESPEED_|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|ELEVENLABS_|REPLICATE_|RUNWAY|KLING_|HEYGEN_|PEXELS_|PIXABAY_"
    r"|SUNO_|MINIMAX_|XAI_|HF_|HUGGING|ATLAS_|MODAL_|HIGGSFIELD_|LUMA_|STABILITY_|DEEPGRAM_|ASSEMBLYAI_)"
)
DEFAULT_EDL_HOME = Path(__file__).resolve().parents[2]

PURPOSE_MAX_CHARS = 200
_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

# ------------------------------------------------------------------ OpenMontage context -> schema の値

ASSET_KINDS = ("kinetic-typography", "subtitle", "slideshow", "b-roll", "talking-head", "product-shot", "scene", "image", "other")
# OpenMontage の tool capability（tools/*.py の `capability`）-> paid-generation-gate の asset_kind
CAPABILITY_TO_ASSET_KIND = {
    "video_generation": "scene",
    "image_generation": "image",
    "avatar": "talking-head",
    "character_animation": "talking-head",
    "subtitle": "subtitle",
    "clip_retrieval": "b-roll",
    "clip_acquisition": "b-roll",
    "graphics": "other",
}
STYLES = ("flat", "motion-graphics", "photoreal", "cinematic", "anime", "unspecified")
STYLE_ALIASES = {"motion_graphics": "motion-graphics", "realistic": "photoreal", "photorealistic": "photoreal", "film": "cinematic"}

_LOCAL_PATH = re.compile(r"(?:(?<![A-Za-z])[A-Za-z]:[\\/][^\s\"'<>|]*|(?<![\w.:/])/(?:Users|home|mnt|tmp|var)/[^\s\"'<>|]*)")
_PII_OR_SECRET = [
    re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"),                      # メールアドレス
    re.compile(r"(?<!\d)0\d{1,4}-?\d{1,4}-?\d{3,4}(?!\d)"),         # 電話番号（国内）
    re.compile(r"\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}"),  # 電話番号（国際）
    re.compile(r"\b(sk|pk|rk)[-_][A-Za-z0-9_-]{12,}"),              # API key 風
    re.compile(r"\b[A-Za-z0-9_-]*(api[_-]?key|secret|token|password)[A-Za-z0-9_-]*\s*[:=]", re.I),
    re.compile(r"\b[A-Fa-f0-9]{32,}\b"),                           # 長い hex（key / hash）
]


def screen_purpose(text):
    """purpose を Engine へ送れる形にする。疑いがあれば 1 文字も送らない。戻り値 (purpose, withheld: bool)"""
    s = str(text or "").strip()
    if not s:
        return "(purpose not given)", False
    if any(p.search(s) for p in _PII_OR_SECRET):
        return "(purpose withheld by adapter screening)", True
    s = _LOCAL_PATH.sub("[path]", s)
    return s[:PURPOSE_MAX_CHARS], False


def _asset_kind(req):
    kind = req.get("asset_kind")
    if kind in ASSET_KINDS:
        return kind
    return CAPABILITY_TO_ASSET_KIND.get(req.get("capability"), "other")


def _style(req):
    s = req.get("style")
    if s in STYLES:
        return s
    return STYLE_ALIASES.get(str(s or "").strip().lower(), "unspecified")


def usd_to_micros(value):
    """OpenMontage の estimate_cost（USD float）-> 整数 micros。数値でない・負・非有限は None（送らない）"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value < 0:
        return None
    return int(round(value * 1_000_000))


def build_paid_generation_gate_request(asset_request):
    """OpenMontage の asset request（構造情報）-> Common Decision Contract v1 request。

    asset_request（caller = OpenMontage workflow / agent が組む）:
        capability | asset_kind, purpose, style, duration_sec, has_reference_media, has_local_assets,
        estimated_cost_usd（tool.estimate_cost の値）, language,
        tool / provider / model / pipeline_stage（context のみ。Engine へ送らない）
    """
    req = dict(asset_request or {})
    purpose, withheld = screen_purpose(req.get("purpose"))
    inp = {
        "asset_kind": _asset_kind(req),
        "purpose": purpose,
        "style": _style(req),
        "language": str(req.get("language") or "ja")[:16],
    }
    d = req.get("duration_sec")
    if isinstance(d, (int, float)) and not isinstance(d, bool) and math.isfinite(d) and d >= 0:
        inp["duration_sec"] = d
    for k in ("has_reference_media", "has_local_assets"):
        if isinstance(req.get(k), bool):
            inp[k] = req[k]
    micros = usd_to_micros(req.get("estimated_cost_usd"))
    if micros is not None:
        inp["estimated_paid_cost_usd_micros"] = micros

    digest = hashlib.sha256(json.dumps(inp, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:24]
    context = {"source": "openmontage-adapter", "adapter_kit_version": KIT_VERSION, "purpose_withheld": withheld}
    for k in ("tool", "provider", "model", "pipeline_stage", "capability"):
        v = req.get(k)
        if isinstance(v, str) and _ID_PATTERN.match(v):
            context[k] = v
    return {
        "contract_version": CONTRACT_VERSION,
        "decision_type": DECISION_TYPE,
        "application_id": APPLICATION_ID,
        "project_id": PROJECT_ID,
        "correlation_id": f"openmontage:{digest}",
        "input": inp,
        # context は Decision Engine へは送られない（参照用の識別子だけ）
        "context": context,
    }


# ------------------------------------------------------------------ transport（consumer-kit conformance に従う）

def resolve_edl_home(env=None):
    env = os.environ if env is None else env
    v = env.get("EDL_HOME")
    return Path(v).resolve() if v and v.strip() else DEFAULT_EDL_HOME


def load_engine_env_spec(edl_home):
    empty = {"prefixes": [], "names": []}
    try:
        doc = json.loads((Path(edl_home) / ENGINE_ENV_MANIFEST).read_text(encoding="utf-8"))
        prefixes = doc.get("forward", {}).get("prefixes")
        names = doc.get("forward", {}).get("names")
        if not isinstance(prefixes, list) or not isinstance(names, list):
            return empty
        if not all(isinstance(p, str) and re.fullmatch(r"[A-Z][A-Z0-9]*_", p) for p in prefixes):
            return empty
        if not all(isinstance(n, str) and re.fullmatch(r"[A-Z][A-Z0-9_]*", n) for n in names):
            return empty
        return {"prefixes": prefixes, "names": names}
    except Exception:  # noqa: BLE001 - 読めなければ EDL_* のみ（fail-closed）
        return empty


def build_child_env(env, spec, never_forward=NEVER_FORWARD):
    prefixes = [GATEWAY_NAMESPACE_PREFIX, *spec["prefixes"]]
    out = {}
    for k, v in env.items():
        if v is None or (never_forward is not None and never_forward.search(k)):
            continue
        if k in OS_ENV_KEYS or k in spec["names"] or any(k.startswith(p) for p in prefixes):
            out[k] = v
    return out


def unavailable_envelope(code, request=None, kind="gateway_unreachable", retryable=None):
    request = request or {}
    return {
        "contract_version": CONTRACT_VERSION,
        "ok": False,
        "request_id": request.get("request_id"),
        "correlation_id": request.get("correlation_id"),
        "decision": None,
        "error": {"code": code, "kind": kind, "retryable": (code != "GATEWAY_NOT_FOUND") if retryable is None else retryable},
        "failure": {"policy": "human-required", "human_required": True, "proceed_automatically": False},
        "gateway": None,
    }


def resolve_local_transport_environment(requested="dev"):
    if requested not in RUNTIME_ENVIRONMENTS:
        return {"ok": False, "code": "ENVIRONMENT_UNKNOWN"}
    if requested not in LOCAL_TRANSPORT_ENVIRONMENTS:
        return {"ok": False, "code": "ENVIRONMENT_NOT_SUPPORTED_BY_TRANSPORT"}
    return {"ok": True, "environment": requested}


def verify_envelope(envelope, expected_environment, request=None):
    if not isinstance(envelope, dict) or envelope.get("contract_version") != CONTRACT_VERSION or not isinstance(envelope.get("ok"), bool):
        return unavailable_envelope("GATEWAY_BAD_RESPONSE", request)
    if not envelope["ok"]:
        return envelope
    if not isinstance(envelope.get("decision"), dict):
        return unavailable_envelope("GATEWAY_BAD_RESPONSE", request)
    if (envelope.get("gateway") or {}).get("environment") != expected_environment:
        return unavailable_envelope("ENVIRONMENT_MISMATCH", envelope, kind="environment_mismatch", retryable=False)
    return envelope


def call_gateway(request, env=None, environment="dev", timeout_s=DEFAULT_TIMEOUT_S, never_forward=NEVER_FORWARD, run=subprocess.run):
    """request を local CLI Gateway へ stdin で渡し、検証済み envelope を返す。失敗しても例外を投げない。"""
    env = dict(os.environ) if env is None else env
    resolved = resolve_local_transport_environment(environment)
    if not resolved["ok"]:
        return unavailable_envelope(resolved["code"], request, kind="environment_config", retryable=False)
    req = {**request, "contract_version": CONTRACT_VERSION, "expected_environment": resolved["environment"]}
    edl_home = resolve_edl_home(env)
    cli = edl_home / "src" / "cli.mjs"
    node = shutil.which("node", path=env.get("PATH") or env.get("Path"))
    if not cli.is_file() or not node:
        return unavailable_envelope("GATEWAY_NOT_FOUND", req)
    child_env = build_child_env(env, load_engine_env_spec(edl_home), never_forward)
    kwargs = {}
    if os.name == "nt":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        proc = run(
            [node, str(cli), "gateway", "decide", "--stdin"],
            input=json.dumps(req, ensure_ascii=False).encode("utf-8"),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,  # stderr は表示・保存しない
            env=child_env, timeout=timeout_s, check=False, **kwargs,
        )
    except subprocess.TimeoutExpired:
        return unavailable_envelope("GATEWAY_TIMEOUT", req)
    except OSError:
        return unavailable_envelope("GATEWAY_SPAWN_FAILED", req)
    try:
        envelope = json.loads(proc.stdout.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        envelope = None
    return verify_envelope(envelope, resolved["environment"], req)


# ------------------------------------------------------------------ 結果の解釈（OpenMontage workflow 向け）

PAID_EXECUTION = "human-only: /en-generate (MA-17 estimate -> Human approval -> run-approved)"
NEXT_STEPS = {
    "local": "手元素材＋無料ローカルツールで制作する候補（有料生成は不要な可能性）",
    "remotion": "OpenMontage の Remotion 描画（無料）で制作する候補（有料生成は不要な可能性）",
    "en-generate-hub": "有料生成の候補。/en-generate（MA-17）で見積→Human-only承認へ進む。OpenMontage 内蔵の有料 tool は直接実行しない",
    "human-review": "経路を決める前に Human の確認が必要",
}


def interpret(envelope):
    """envelope -> OpenMontage workflow が読む最小の形。承認・実行を意味するキーは持たない。"""
    base = {
        "decision_type": DECISION_TYPE,
        "proceed_automatically": False,
        "paid_execution": PAID_EXECUTION,
        "openmontage_builtin_paid_tools": "forbidden",
    }
    if not isinstance(envelope, dict) or envelope.get("ok") is not True or not isinstance(envelope.get("decision"), dict):
        env = envelope if isinstance(envelope, dict) else {}
        return {
            **base,
            "status": "unavailable",
            "route": "human-review",
            "next_step": "判定を取得できなかったので Human が判断する（failure policy に従う・自動で進めない）",
            "human_check": True,
            "error_code": (env.get("error") or {}).get("code", "GATEWAY_UNAVAILABLE"),
            "failure_policy": (env.get("failure") or {}).get("policy", "human-required"),
            "request_id": env.get("request_id"),
            "environment": (env.get("gateway") or {}).get("environment"),
        }
    d = envelope["decision"]
    o = d.get("outcome") or {}
    escalated = o.get("escalated") is True
    route = "human-review" if escalated else o.get("recommended_route")
    if route not in NEXT_STEPS:
        route = "human-review"
    human_check = (d.get("human_gate") or {}).get("required") is True or d.get("tier") != "auto" or route == "human-review"
    trace = (d.get("fallback") or {}).get("trace") or []
    # 外部の判断経路へ実際に届いたか（adapter 名で分岐しない：engine を替えても意味が変わらない）
    engine_attempt = next((t for t in trace if isinstance(t, dict) and t.get("networked") is True and t.get("status") == "ok"), None)
    reason = (d.get("human_gate") or {}).get("reason") or d.get("rationale")
    return {
        **base,
        "status": "decided",
        "route": route,
        "next_step": NEXT_STEPS[route],
        "tier": d.get("tier"),
        "human_check": human_check,
        "paid_candidate": None if escalated else (o.get("paid_generation_required") if isinstance(o.get("paid_generation_required"), bool) else None),
        "resolved_by": d.get("resolved_by"),
        "provider": d.get("provider"),
        "confidence": d.get("confidence") if isinstance(d.get("confidence"), (int, float)) else None,
        "external_engine_reached": engine_attempt is not None,
        "reason": reason[:300] if isinstance(reason, str) else None,
        "request_id": envelope.get("request_id"),
        "environment": (envelope.get("gateway") or {}).get("environment"),
    }


def decide(asset_request, env=None, **kwargs):
    """1 asset request を判定する。戻り値 (interpretation, envelope)"""
    envelope = call_gateway(build_paid_generation_gate_request(asset_request), env=env, **kwargs)
    return interpret(envelope), envelope


def format_text(i):
    lines = ["【E-NEXUS Decision Gateway：OpenMontage 有料生成の前段判定（paid-generation-gate）】"]
    if i["status"] == "unavailable":
        lines.append(f"判定：取得できませんでした（{i['error_code']}）／扱い：failure policy = {i['failure_policy']}（Human が判断）")
    else:
        lines.append(f"推奨経路：{i['route']} — {i['next_step']}")
        lines.append(f"tier：{i['tier']}／Human確認：{'必要' if i['human_check'] else '経路判定としては不要'}／confidence：{i['confidence']}／判定者：{i['resolved_by']}")
        if i.get("reason"):
            lines.append(f"理由：{i['reason']}")
    lines.append("※この判定は承認ではありません。有料生成は必ず /en-generate（MA-17）の Human-only 承認を通ります。OpenMontage 内蔵の有料 tool は使いません。")
    if i.get("request_id"):
        lines.append(f"request_id：{i['request_id']}／environment：{i.get('environment')}")
    return "\n".join(lines)


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        asset_request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        print(json.dumps({"error": "asset request JSON を stdin で渡してください"}, ensure_ascii=False))
        return 2
    interpretation, envelope = decide(asset_request)
    if "--text" in argv:
        sys.stdout.buffer.write((format_text(interpretation) + "\n").encode("utf-8"))
    else:
        out = {"interpretation": interpretation, "envelope": envelope} if "--json" in argv else interpretation
        sys.stdout.buffer.write((json.dumps(out, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
