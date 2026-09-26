"""E-NEXUS OpenMontage Launcher（2026-09-26・MA-29 × MA-30）。

Human が覚える操作を「この Launcher を起動する」1 つにする。Launcher が OpenMontage を起動し、OpenMontage workflow が
書く gate checkpoint（proposal、proposal を持たない pipeline では scene_plan）を監視して、検知したら preflight wrapper
（enexus_openmontage_preflight.py）→ thin adapter → Common Decision Gateway（DEV）を自動で呼ぶ。

    Human -> Launcher
      -> OpenMontage agent（既定 claude・cwd = OpenMontage clone・有料 provider の鍵を env から外す）
      -> workflow -> checkpoint_proposal.json（awaiting_human）
      -> Launcher が検知（polling・既定 0.25s）-> preflight -> Gateway -> Rules / JEV
      -> 報告（<state>/reports/<project>__<stage>.json / .txt）-> agent は gate 承認を求める前に報告を読む
      -> free-path：OpenMontage の無料経路（Remotion / 手元素材）で進める候補
         paid-handoff：該当生成を OpenMontage 内で実行せず /en-generate（MA-17 Human-only 承認）へ

設計の要点:
    - OpenMontage（AGPL-3.0）のコードを import しない・clone に書かない。checkpoint は JSON として読むだけ（file contract）。
      state / 報告 / log はすべて E-NEXUS 側（既定 data/openmontage-launcher/・gitignore）
    - 同一性は checkpoint の bytes ではなく「Engine へ送る asset request の集合」（preflight.plan_identity）。Human 承認で
      awaiting_human -> completed に書き直されても再判定しない。計画が変わったら再判定する
    - candidate 単位で判定結果を再利用する（correlation_id = input の digest）。retry・計画更新で成功済みの判定を呼び直さない
    - Gateway 呼び出しは全体で同時 2（Gateway の上限 4・burst 5 で 429 の実測）。project が違えば並列に処理する
    - retry は Engine に届いていない失敗だけ即時（GATEWAY_BUSY / GATEWAY_SPAWN_FAILED）。timeout・ENGINE_ERROR・不正応答は
      Engine が走り続けて課金しうる（docs/gateway.md §2）ので pending にして遅延再試行（30s / 120s / 600s）。尽きたら human-review
    - どの結果も承認ではない。有料生成は MA-17 の Human-only 承認だけ。Launcher は OpenMontage の gate・human_approved に触らない
    - DEV のみ（local CLI transport）。EDL_ENVIRONMENT が staging / production なら起動しない（技術スタック正本 §3-8）

CLI（Windows は launch-openmontage.cmd、macOS / Linux は launch-openmontage.sh から呼ぶ）:
    python enexus_openmontage_launcher.py init --openmontage-root <clone>   # 初回だけ（local config を state dir へ保存）
    python enexus_openmontage_launcher.py run [-- <agent へ渡す引数>]        # OpenMontage + 監視 + Decision（既定）
    python enexus_openmontage_launcher.py watch                              # 監視だけ（agent は別に起動済み・常駐用）
    python enexus_openmontage_launcher.py scan-once                          # 1 回走査して判定し終了（cron / Hermes 用）
    python enexus_openmontage_launcher.py status [--json]
    python enexus_openmontage_launcher.py retry <project_id>                 # 判定をやり直す（Human-review 後など）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import enexus_openmontage_decision as om
import enexus_openmontage_preflight as pf

LAUNCHER_ID = "openmontage-launcher"
LAUNCHER_VERSION = "1"
HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
DEFAULT_STATE_DIR = REPO / "data" / "openmontage-launcher"
CONFIG_NAME = "config.json"
STATE_NAME = "state.json"
LOCK_NAME = "launcher.lock"
EVENTS_NAME = "launcher-events.jsonl"
REPORTS_DIRNAME = "reports"
CONTROL_DIRNAME = "control"
EVENTS_MAX_BYTES = 2_000_000

DEFAULT_POLL_S = 0.25
FULL_RESCAN_S = 2.0
RECENT_DIR_NS = 2_000_000_000
DEFAULT_GATEWAY_CONCURRENCY = 2
DEFAULT_WORKERS = 4
DRAIN_TIMEOUT_S = 45.0          # Gateway 呼び出し 1 回（35s）＋余裕
RECOVERY_MAX_AGE_S = 7 * 24 * 3600
TMP_FRESH_S = 5.0
IMMEDIATE_RETRY_CODES = frozenset({"GATEWAY_BUSY", "GATEWAY_SPAWN_FAILED"})
IMMEDIATE_BACKOFF_S = (0.5, 1.5)
DEFERRED_RETRY_CODES = frozenset({"GATEWAY_TIMEOUT", "ENGINE_ERROR", "GATEWAY_BAD_RESPONSE"})
DEFERRED_BACKOFF_S = (30.0, 120.0, 600.0)
LATE_STAGES = ("sample", "assets", "compose")
WATCHED_NAMES = {f"checkpoint_{s}.json": s for s in (*pf.GATE_STAGES, *LATE_STAGES)}

# OpenMontage agent（子 process）の env から外す有料 provider の鍵。MA-29 Human 判断（OpenMontage 内蔵の有料 tool を
# 直接実行しない・有料生成の唯一のゲートは MA-17）を agent の振る舞いに頼らず構造で守る。
# 無料の素材 API（Pexels / Pixabay）・model download（HF）は外さない（能力を不要に削らない）。
PAID_PROVIDER_ENV = re.compile(
    r"^(FAL_|WAVESPEED_|OPENAI_|GOOGLE_|GEMINI_|ELEVENLABS_|REPLICATE_|RUNWAY|KLING_|HEYGEN_|SUNO_|MINIMAX_|XAI_"
    r"|ATLAS_|MODAL_|HIGGSFIELD_|LUMA_|STABILITY_|DEEPGRAM_|ASSEMBLYAI_)"
)
# Decision Engine 用の env も agent には渡さない（各アプリから Decision Engine を直接呼ばせない）。名前は Gateway の
# manifest（policies/gateway/engine-env.json）だけが知る。consumer は Engine 固有の名前を持たない
CHILD_REPORTS_ENV = "ENEXUS_OPENMONTAGE_REPORTS_DIR"


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _atomic_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


# ------------------------------------------------------------------ config


class ConfigError(ValueError):
    """Launcher を起動できない設定"""


@dataclass
class LauncherConfig:
    openmontage_root: Path | None
    projects_dir: Path
    state_dir: Path = DEFAULT_STATE_DIR
    agent: list | None = None                 # None = 監視だけ
    agent_console: str = "new"                # new（Windows：別 console）/ inherit
    capture_agent_output: bool = False        # 非対話の agent（claude -p・smoke driver 等）の stdout/stderr を log へ
    agent_brief: bool = True
    strip_paid_provider_env: bool = True
    poll_s: float = DEFAULT_POLL_S
    gateway_concurrency: int = DEFAULT_GATEWAY_CONCURRENCY
    workers: int = DEFAULT_WORKERS
    expected_environment: str = "dev"
    gateway_env: dict | None = None           # None = os.environ（test は fake Gateway の EDL_HOME を渡す）
    immediate_backoff_s: tuple = IMMEDIATE_BACKOFF_S
    deferred_backoff_s: tuple = DEFERRED_BACKOFF_S
    recovery_max_age_s: float = RECOVERY_MAX_AGE_S
    console: bool = True

    @property
    def reports_dir(self):
        return self.state_dir / REPORTS_DIRNAME

    @property
    def control_dir(self):
        return self.state_dir / CONTROL_DIRNAME


def load_local_config(state_dir):
    p = Path(state_dir) / CONFIG_NAME
    if not p.exists():
        return {}
    try:
        doc = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError) as e:
        raise ConfigError(f"{p} を読めません: {e}") from None
    if not isinstance(doc, dict):
        raise ConfigError(f"{p} が object ではありません")
    return doc


def resolve_projects_dir(root, env, explicit=None):
    """OpenMontage の lib/paths.py と同じ解決（OPENMONTAGE_PROJECTS_DIR、無ければ <root>/projects）"""
    if explicit:
        return Path(explicit).resolve()
    v = env.get("OPENMONTAGE_PROJECTS_DIR")
    if v and v.strip():
        return Path(v).resolve()
    if root is None:
        raise ConfigError("OpenMontage の場所が分かりません（--openmontage-root / OPENMONTAGE_ROOT / init）")
    return (Path(root) / "projects").resolve()


def resolve_agent_command(spec, extra_args=()):
    """agent の argv。既定 'claude'：Windows の npm shim（claude.cmd）は cmd.exe を経由して引数の quoting が壊れうるので、
    同梱の claude.exe があればそれを直接起動する"""
    if spec in (None, "", "none", []):
        return None
    if isinstance(spec, str):
        if spec != "claude":
            raise ConfigError("agent は 'claude'・'none'・または argv の JSON 配列で指定してください")
        exe = shutil.which("claude")
        if not exe:
            raise ConfigError("claude が PATH にありません（agent を指定するか 'none' で監視だけにしてください）")
        if exe.lower().endswith((".cmd", ".bat")):
            native = Path(exe).parent / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
            if native.is_file():
                exe = str(native)
        return [exe, *extra_args]
    if isinstance(spec, list) and spec and all(isinstance(a, str) for a in spec):
        return [*spec, *extra_args]
    raise ConfigError("agent の指定が不正です")


def build_config(args=None, env=None):
    """CLI 引数 -> env（OPENMONTAGE_ROOT 等）-> local config（<state>/config.json）の順に解決する"""
    env = os.environ if env is None else env
    a = vars(args) if args is not None else {}
    state_dir = Path(a.get("state_dir") or env.get("ENEXUS_OPENMONTAGE_STATE_DIR") or DEFAULT_STATE_DIR).resolve()
    # init で保存した既定の config を基準にし、別の state dir に config があればそれで上書きする
    local = load_local_config(DEFAULT_STATE_DIR)
    if state_dir != DEFAULT_STATE_DIR.resolve():
        local.update(load_local_config(state_dir))
    root = a.get("openmontage_root") or env.get("OPENMONTAGE_ROOT") or local.get("openmontage_root")
    root = Path(root).resolve() if root else None
    if root is not None and not root.is_dir():
        raise ConfigError(f"OpenMontage の場所が存在しません: {root}")
    projects = resolve_projects_dir(root, env, a.get("projects_dir") or local.get("projects_dir"))
    requested_env = (env.get("EDL_ENVIRONMENT") or "dev").strip() or "dev"
    if requested_env != "dev":
        # local CLI transport は DEV のみ。staging / production の Gateway へ推測接続しない
        raise ConfigError(f"EDL_ENVIRONMENT={requested_env} では起動しません（この Launcher は DEV 専用）")
    agent_spec = a.get("agent") if a.get("agent") is not None else local.get("agent", "claude")
    if isinstance(agent_spec, str) and agent_spec.startswith("["):
        try:
            agent_spec = json.loads(agent_spec)
        except ValueError:
            raise ConfigError("--agent の JSON 配列を読めません") from None
    mode = a.get("mode") or "run"
    agent = None
    if mode == "run":
        if root is None and agent_spec == "claude":
            raise ConfigError("OpenMontage の場所が分かりません（初回は init --openmontage-root <clone> を実行してください）")
        agent = resolve_agent_command(agent_spec, a.get("agent_args") or ())
    console_default = "new" if os.name == "nt" else "inherit"
    return LauncherConfig(
        openmontage_root=root,
        projects_dir=projects,
        state_dir=state_dir,
        agent=agent,
        agent_console=a.get("agent_console") or local.get("agent_console") or console_default,
        capture_agent_output=bool(a.get("capture_agent_output") or local.get("capture_agent_output", False)),
        agent_brief=not a.get("no_brief") and local.get("agent_brief", True),
        strip_paid_provider_env=local.get("strip_paid_provider_env", True),
        poll_s=float(a.get("poll_s") or local.get("poll_s") or DEFAULT_POLL_S),
        gateway_concurrency=int(local.get("gateway_concurrency") or DEFAULT_GATEWAY_CONCURRENCY),
        console=not a.get("quiet"),
    )


# ------------------------------------------------------------------ state / lock / log


class StateStore:
    """E-NEXUS 側の処理状態（checkpoint 1 件 = key "<project_id>/<stage>"）。atomic に保存する。Secret・本文は持たない"""

    def __init__(self, path):
        self.path = Path(path)
        self._lock = threading.RLock()
        self.doc = {"version": 1, "entries": {}}
        if self.path.exists():
            try:
                doc = json.loads(self.path.read_text(encoding="utf-8"))
                if isinstance(doc, dict) and isinstance(doc.get("entries"), dict):
                    self.doc = doc
            except (ValueError, OSError):
                # 壊れた state は退避して空から始める（処理済みの再判定は cache が無いぶん Gateway を呼び直すだけ）
                try:
                    os.replace(self.path, self.path.with_name(self.path.name + f".corrupt-{int(time.time())}"))
                except OSError:
                    pass

    def get(self, key):
        with self._lock:
            e = self.doc["entries"].get(key)
            return json.loads(json.dumps(e)) if e is not None else None

    def update(self, key, **fields):
        with self._lock:
            e = self.doc["entries"].setdefault(key, {})
            e.update(fields)
            e["updated_at"] = now_iso()
            self._save()
            return dict(e)

    def entries(self):
        with self._lock:
            return json.loads(json.dumps(self.doc["entries"]))

    def due(self, now):
        """再試行時刻が来た pending の key（毎 tick 呼ぶので全体をコピーしない）"""
        with self._lock:
            return [k for k, e in self.doc["entries"].items()
                    if e.get("status") == "pending" and (e.get("next_retry_at") or 0) <= now]

    def _save(self):
        self.doc["updated_at"] = now_iso()
        _atomic_write(self.path, json.dumps(self.doc, ensure_ascii=False, indent=1) + "\n")


def _pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if os.name == "nt":
        try:
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"], capture_output=True,
                                 text=True, timeout=10, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return f'"{pid}"' in out.stdout
        except (OSError, subprocess.SubprocessError):
            return True  # 判定できないときは生きている扱い（二重起動しない側へ倒す）
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class SingleInstanceLock:
    """同じ state dir で Launcher を 2 つ動かさない（二重判定・state の取り合いを防ぐ）。死んだ pid の lock は回収する"""

    def __init__(self, path):
        self.path = Path(path)
        self.held = False

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump({"pid": os.getpid(), "started_at": now_iso()}, f)
                self.held = True
                return True
            except FileExistsError:
                owner = self.owner()
                if owner and _pid_alive(owner.get("pid")):
                    return False
                try:
                    self.path.unlink()
                except FileNotFoundError:
                    pass
        return False

    def owner(self):
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def release(self):
        if self.held:
            try:
                self.path.unlink()
            except FileNotFoundError:
                pass
            self.held = False


CONSOLE_EVENTS = {
    "launcher_start", "launcher_stop", "agent_start", "agent_exit", "checkpoint_detected", "decision_done",
    "decision_pending", "decision_failed", "decision_retry", "late_checkpoint", "paid_stage_without_decision",
    "paid_stage_with_handoff", "invalid_checkpoint", "warning", "retry_requested",
}


class EventLog:
    """観測用 JSONL（<state>/launcher-events.jsonl・2MB で 1 世代 rotate）と console 表示"""

    def __init__(self, path, console=True, stream=None):
        self.path = Path(path)
        self.console = console
        self.stream = stream or sys.stdout
        self._lock = threading.Lock()

    def emit(self, event, **fields):
        entry = {"ts": now_iso(), "event": event, **{k: v for k, v in fields.items() if v is not None}}
        line = json.dumps(entry, ensure_ascii=False, default=str)
        with self._lock:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                if self.path.exists() and self.path.stat().st_size > EVENTS_MAX_BYTES:
                    os.replace(self.path, self.path.with_name(self.path.name + ".1"))
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except OSError:
                pass  # 観測の失敗で判定を止めない
            if self.console and event in CONSOLE_EVENTS:
                try:
                    self.stream.write(format_console(entry) + "\n")
                    self.stream.flush()
                except (OSError, ValueError, UnicodeEncodeError):
                    pass
        return entry


def format_console(e):
    t = e["ts"][11:19]
    ev = e["event"]
    k = e.get("key", "")
    if ev == "launcher_start":
        return f"[{t}] 起動    E-NEXUS OpenMontage Launcher v{LAUNCHER_VERSION}（DEV）監視: {e.get('projects_dir')}"
    if ev == "agent_start":
        return (f"[{t}] 起動    OpenMontage agent pid={e.get('pid')}（子envから外した鍵：有料provider {e.get('stripped_paid_count')}件"
                f"・Decision Engine用 {e.get('stripped_engine_count')}件）")
    if ev == "agent_exit":
        return f"[{t}] 終了    OpenMontage agent exit={e.get('code')}"
    if ev == "checkpoint_detected":
        return f"[{t}] 検知    {k}（{e.get('status')}）plan={e.get('identity')} 検知遅延 {e.get('detect_latency_ms')}ms"
    if ev == "decision_done":
        mark = "⚠ 有料候補 → /en-generate（MA-17 Human承認）: " + ", ".join(e.get("handoff") or []) if e.get("overall") == "paid-handoff" else ""
        return (f"[{t}] 判定    {k} → {e.get('overall')} {mark}（{e.get('summary')}・{e.get('preflight_ms')}ms）"
                f" 報告: {e.get('report')}")
    if ev == "decision_pending":
        return f"[{t}] 保留    {k} → Gateway 一時障害 {e.get('codes')}。{e.get('retry_in_s')}s 後に再試行（その間は human-review 扱い）"
    if ev == "decision_failed":
        return f"[{t}] 要確認  {k} → 判定を取得できませんでした {e.get('codes')}（human-review・自動で進めない）"
    if ev == "decision_retry":
        return f"[{t}] 再試行  {k} {e.get('code')}（{e.get('attempt')}回目）"
    if ev == "late_checkpoint":
        return f"[{t}] 注意    {k} は gate 承認済みで後段が始まっています（判定を省略・human-review）"
    if ev == "paid_stage_without_decision":
        return f"[{t}] 警告    {k} が始まりましたが Decision の記録がありません（gate 無しで進んだ可能性・Human が確認）"
    if ev == "paid_stage_with_handoff":
        return f"[{t}] 注意    {k} 開始。有料候補（{', '.join(e.get('handoff') or [])}）は OpenMontage 内で実行しないこと"
    if ev == "invalid_checkpoint":
        return f"[{t}] 無視    {k}: {e.get('error')}"
    if ev == "retry_requested":
        return f"[{t}] 再判定  {e.get('project_id')} を再判定します"
    if ev == "launcher_stop":
        return f"[{t}] 停止    判定 {e.get('decided')} 件・保留 {e.get('pending')} 件・重複スキップ {e.get('duplicates')} 件"
    return f"[{t}] {ev} {e.get('message', '')}"


# ------------------------------------------------------------------ watcher


@dataclass
class Change:
    key: str
    project_id: str
    stage: str
    path: Path
    mtime_ns: int
    size: int


class CheckpointScanner:
    """projects/<id>/checkpoint_<stage>.json の変化を polling で拾う（stdlib のみ・OS 非依存）。

    - 走査は depth 1（history/ 等の下は見ない）。project dir の mtime が変わったときと FULL_RESCAN_S ごとだけ中を列挙する
    - OpenMontage は .json.tmp へ書いて os.replace する。tmp が残っている間はその project を次の tick へ回す
    - file を開きっぱなしにしない（Windows では開いている file への os.replace が失敗し OpenMontage の書き込みを壊す）
    - 別実装（watchfiles / FSEvents）へ差し替えるときは scan() -> [Change] の形を保つ
    """

    def __init__(self, projects_dir, full_rescan_s=FULL_RESCAN_S):
        self.projects_dir = Path(projects_dir)
        self.full_rescan_s = full_rescan_s
        self.seen = {}        # path -> (mtime_ns, size)
        self.dir_mtime = {}   # project dir -> mtime_ns
        self.last_full = 0.0
        self.scan_count = 0
        self.scan_total_s = 0.0

    def forget(self, path):
        if path:
            self.seen.pop(Path(path), None)

    @staticmethod
    def _fresh(path, window_s=None):
        window_s = TMP_FRESH_S if window_s is None else window_s
        try:
            return (time.time() - os.stat(path).st_mtime) < window_s
        except OSError:
            return False

    def scan(self):
        t0 = time.perf_counter()
        out = []
        full = (time.monotonic() - self.last_full) >= self.full_rescan_s
        if full:
            self.last_full = time.monotonic()
        try:
            projects = [e for e in os.scandir(self.projects_dir) if e.is_dir(follow_symlinks=False)]
        except OSError:
            projects = []
        for pe in projects:
            pdir = Path(pe.path)
            try:
                m = os.stat(pdir).st_mtime_ns
            except OSError:
                continue
            # mtime が同じでも直近の変更は信用しない：時計の刻み（Windows で約 1〜16ms）の中で dir 作成と file 書き込みが
            # 続くと dir の mtime が変わらず、見逃すと全体再走査（FULL_RESCAN_S）まで検知が遅れる（2026-09-26 実測 2072ms）
            if not full and self.dir_mtime.get(pdir) == m and (time.time_ns() - m) > RECENT_DIR_NS:
                continue
            try:
                names = {e.name for e in os.scandir(pdir)}
            except OSError:
                continue
            if any(n.endswith(".json.tmp") and self._fresh(pdir / n) for n in names):
                continue  # OpenMontage が書き込み中。dir_mtime を更新せず次の tick で見る（残骸の tmp は無視）
            self.dir_mtime[pdir] = m
            for name, stage in WATCHED_NAMES.items():
                if name not in names:
                    continue
                p = pdir / name
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                sig = (st.st_mtime_ns, st.st_size)
                if self.seen.get(p) == sig:
                    continue
                self.seen[p] = sig
                out.append(Change(key=f"{pe.name}/{stage}", project_id=pe.name, stage=stage, path=p,
                                  mtime_ns=st.st_mtime_ns, size=st.st_size))
        self.scan_count += 1
        self.scan_total_s += time.perf_counter() - t0
        return out

    @property
    def scan_avg_ms(self):
        return round(1000 * self.scan_total_s / self.scan_count, 3) if self.scan_count else None


# ------------------------------------------------------------------ agent（OpenMontage）process


def agent_brief(reports_dir):
    """agent へ session 限りで追記する指示（上流 file は変えない）。cmd.exe を経由しても壊れない文字だけで 1 行にする"""
    return (
        "[E-NEXUS Launcher] This OpenMontage session is watched by the E-NEXUS OpenMontage Launcher. "
        "When you write checkpoint_proposal.json (or checkpoint_scene_plan.json in pipelines without a proposal stage) "
        "with status awaiting_human, the launcher automatically runs the E-NEXUS Decision Gateway (paid-generation-gate) "
        f"and writes PROJECTID__STAGE.txt and .json into {reports_dir} within seconds. "
        "Before asking the human to approve that gate, read the report whose timestamp matches your checkpoint and show its verdict. "
        "Tools or generation listed under handoff_to_en_generate must NOT run inside OpenMontage; paid generation goes only through "
        "/en-generate (MA-17) with human-only approval. Paid provider API keys are intentionally absent in this session; "
        "prefer free and local paths (Remotion, local assets, free stock). Do not edit E-NEXUS files and do not call the wrapper yourself. "
        "The report is not an approval of the gate."
    )


def child_env(base, cfg, reports_dir):
    spec = om.load_engine_env_spec(om.resolve_edl_home(cfg.gateway_env or os.environ))
    engine_prefixes = (om.GATEWAY_NAMESPACE_PREFIX, *spec["prefixes"])
    engine_names = set(spec["names"])
    env, stripped = {}, []
    for k, v in base.items():
        ku = k.upper()
        if cfg.strip_paid_provider_env and PAID_PROVIDER_ENV.search(ku):
            stripped.append(k)
            continue
        if ku.startswith(engine_prefixes) or ku in engine_names:
            stripped.append(k)
            continue
        env[k] = v
    env["OPENMONTAGE_PROJECTS_DIR"] = str(cfg.projects_dir)   # Launcher と OpenMontage が同じ root を見る
    env[CHILD_REPORTS_ENV] = str(reports_dir)
    env["ENEXUS_OPENMONTAGE_LAUNCHER"] = LAUNCHER_VERSION
    return env, stripped


def bind_child_lifetime(pid):
    """Windows：Launcher が落ちたら agent（process tree）も落ちる Job Object に入れる。監視なしの agent を残さない。
    失敗しても起動は続ける（戻り値 None。agent_start の lifetime_bound=false で分かる）。POSIX は同じ端末の SIGHUP に任せる"""
    if os.name != "nt":
        return None
    try:
        import ctypes
        from ctypes import wintypes

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
        k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)

        class Basic(ctypes.Structure):
            _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                        ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                        ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                        ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

        class Io(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rt", "wt", "ot")]

        class Extended(ctypes.Structure):
            _fields_ = [("BasicLimitInformation", Basic), ("IoInfo", Io), ("ProcessMemoryLimit", ctypes.c_size_t),
                        ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                        ("PeakJobMemoryUsed", ctypes.c_size_t)]

        job = k32.CreateJobObjectW(None, None)
        if not job:
            return None
        info = Extended()
        info.BasicLimitInformation.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            k32.CloseHandle(job)
            return None
        h = k32.OpenProcess(0x0101, False, pid)  # PROCESS_SET_QUOTA | PROCESS_TERMINATE
        if not h:
            k32.CloseHandle(job)
            return None
        ok = k32.AssignProcessToJobObject(job, h)
        k32.CloseHandle(h)
        if not ok:
            k32.CloseHandle(job)
            return None
        return job  # handle は Launcher の寿命まで持つ（閉じた時点で tree が終了する）
    except (OSError, AttributeError, ValueError):
        return None


class AgentProcess:
    def __init__(self, argv, cwd, env, console="new", capture=False, log=None):
        self.argv, self.cwd, self.env = argv, cwd, env
        self.console, self.capture, self.log = console, capture, log
        self.proc = None
        self.job = None
        self._readers = []

    def start(self):
        kwargs = {}
        if os.name == "nt" and self.console == "new":
            kwargs["creationflags"] = subprocess.CREATE_NEW_CONSOLE
        if self.capture:
            kwargs.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.proc = subprocess.Popen(self.argv, cwd=self.cwd, env=self.env, **kwargs)
        self.job = bind_child_lifetime(self.proc.pid)
        if self.capture:
            for name, stream in (("stdout", self.proc.stdout), ("stderr", self.proc.stderr)):
                t = threading.Thread(target=self._pump, args=(name, stream), daemon=True)
                t.start()
                self._readers.append(t)
        return self.proc.pid

    def _pump(self, name, stream):
        for raw in iter(stream.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip()
            if line and self.log:
                self.log.emit("agent_output", stream=name, line=line[:500])

    def poll(self):
        return self.proc.poll() if self.proc else None

    def wait_readers(self, timeout=2.0):
        for t in self._readers:
            t.join(timeout)
        for stream in (self.proc.stdout, self.proc.stderr) if self.proc else ():
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass

    def stop(self, grace_s=5.0):
        """process tree ごと止める（claude は子 process を持つ）。まず穏当に、残れば強制"""
        if not self.proc or self.proc.poll() is not None:
            return self.proc.returncode if self.proc else None
        if os.name == "nt":
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T"], capture_output=True, creationflags=flags)
            try:
                return self.proc.wait(grace_s)
            except subprocess.TimeoutExpired:
                subprocess.run(["taskkill", "/PID", str(self.proc.pid), "/T", "/F"], capture_output=True, creationflags=flags)
        else:
            self.proc.terminate()
            try:
                return self.proc.wait(grace_s)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        try:
            return self.proc.wait(grace_s)
        except subprocess.TimeoutExpired:
            return None
        finally:
            self.wait_readers(0.5)


# ------------------------------------------------------------------ launcher core


def _slim(interp):
    """state に残す判定（reason 等の本文は報告 file だけに置く）"""
    keys = ("status", "route", "tier", "human_check", "paid_candidate", "confidence", "resolved_by", "provider",
            "external_engine_reached", "request_id", "environment", "error_code")
    return {k: interp.get(k) for k in keys if interp.get(k) is not None}


class Launcher:
    """監視・判定・agent lifecycle。UI（CLI / 将来の GUI・tray・Hermes・Mac mini daemon）は on_event と status() だけを使う"""

    def __init__(self, cfg, decide=None, stream=None, clock=time.time, sleep=time.sleep):
        self.cfg = cfg
        self.decide_fn = decide or om.decide
        self.clock, self.sleep = clock, sleep
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        self.state = StateStore(cfg.state_dir / STATE_NAME)
        self.log = EventLog(cfg.state_dir / EVENTS_NAME, console=cfg.console, stream=stream)
        self.lock = SingleInstanceLock(cfg.state_dir / LOCK_NAME)
        self.scanner = CheckpointScanner(cfg.projects_dir)
        self.pool = ThreadPoolExecutor(max_workers=cfg.workers, thread_name_prefix="om-decision")
        self.gw_sem = threading.BoundedSemaphore(max(1, cfg.gateway_concurrency))
        self._mu = threading.Lock()
        self.inflight = {}       # key -> Future
        self.dirty = set()       # 処理中に計画が更新された key（終わったら読み直す）
        self.stop_event = threading.Event()
        self.agent = None
        self.started_at = None
        self.counters = {"decided": 0, "pending": 0, "failed": 0, "duplicates": 0, "gateway_calls": 0, "cache_hits": 0}

    def _count(self, name):
        with self._mu:
            self.counters[name] += 1

    # ---------- public API

    def start(self):
        if not self.lock.acquire():
            owner = self.lock.owner() or {}
            raise ConfigError(f"別の Launcher が動いています（pid={owner.get('pid')}）。status で確認してください")
        self.started_at = self.clock()
        self.cfg.reports_dir.mkdir(parents=True, exist_ok=True)
        self.cfg.control_dir.mkdir(parents=True, exist_ok=True)
        self.log.emit("launcher_start", version=LAUNCHER_VERSION, projects_dir=str(self.cfg.projects_dir),
                      state_dir=str(self.cfg.state_dir), environment=self.cfg.expected_environment,
                      poll_s=self.cfg.poll_s, gateway_concurrency=self.cfg.gateway_concurrency,
                      agent=bool(self.cfg.agent))
        self._warn_upstream_env()
        self._recover()

    def tick(self):
        """1 周：control 要求 -> 走査 -> 遅延再試行。main loop・scan-once・test から呼ぶ"""
        self._consume_control()
        for ch in self.scanner.scan():
            self._on_change(ch)
        self._schedule_due()

    def run(self):
        """agent を起動し、終わるまで監視する。戻り値は process の exit code"""
        self.start()
        exit_code = 0
        restore = self._install_signals()
        try:
            self.tick()  # 起動前に溜まっていた gate を先に拾う（restart recovery）
            if self.cfg.agent:
                self._start_agent()
            while not self.stop_event.is_set():
                self.tick()
                if self.agent is not None:
                    code = self.agent.poll()
                    if code is not None:
                        self.agent.wait_readers()
                        self.log.emit("agent_exit", code=code, abnormal=code != 0)
                        exit_code = 0 if code == 0 else 3
                        break
                self.stop_event.wait(self.cfg.poll_s)
            else:
                exit_code = 130 if self.agent is not None else 0
        finally:
            self.shutdown()
            restore()
        return exit_code

    def scan_once(self, drain_timeout_s=DRAIN_TIMEOUT_S):
        self.start()
        try:
            self.tick()
            self.drain(drain_timeout_s)
        finally:
            self.shutdown()
        return 0

    def request_stop(self):
        self.stop_event.set()

    def drain(self, timeout_s=DRAIN_TIMEOUT_S):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            with self._mu:
                futs = list(self.inflight.values())
                dirty = bool(self.dirty)
            if not futs and not dirty:
                return True
            for f in futs:
                try:
                    f.result(timeout=max(0.0, deadline - time.monotonic()))
                except Exception:  # noqa: BLE001 - job 内で記録済み
                    pass
            self.tick()
        return False

    def shutdown(self):
        try:
            self.tick()  # 終了直前の最後の走査（agent が最後に書いた gate を取りこぼさない）
            self.drain()
        finally:
            if self.agent is not None and self.agent.poll() is None:
                code = self.agent.stop()
                self.log.emit("agent_exit", code=code, stopped_by_launcher=True)
            self.pool.shutdown(wait=False, cancel_futures=True)
            entries = self.state.entries()
            self.log.emit("launcher_stop", decided=self.counters["decided"],
                          pending=sum(1 for e in entries.values() if e.get("status") == "pending"),
                          duplicates=self.counters["duplicates"], gateway_calls=self.counters["gateway_calls"],
                          cache_hits=self.counters["cache_hits"], scan_avg_ms=self.scanner.scan_avg_ms,
                          scans=self.scanner.scan_count)
            self.lock.release()

    def status(self):
        return build_status(self.cfg)

    # ---------- agent

    def _start_agent(self):
        env, stripped = child_env(os.environ, self.cfg, self.cfg.reports_dir)
        argv = list(self.cfg.agent)
        if self.cfg.agent_brief and Path(argv[0]).name.lower().startswith("claude"):
            argv[1:1] = ["--add-dir", str(self.cfg.reports_dir), "--append-system-prompt", agent_brief(self.cfg.reports_dir)]
        cwd = str(self.cfg.openmontage_root) if self.cfg.openmontage_root else None
        self.agent = AgentProcess(argv, cwd, env, console=self.cfg.agent_console, capture=self.cfg.capture_agent_output, log=self.log)
        pid = self.agent.start()
        # 値は出さない。外した「名前」の件数だけ
        paid = [k for k in stripped if PAID_PROVIDER_ENV.search(k.upper())]
        self.log.emit("agent_start", pid=pid, argv0=Path(argv[0]).name, cwd=cwd, stripped_env_count=len(stripped),
                      stripped_paid_count=len(paid), stripped_engine_count=len(stripped) - len(paid),
                      brief=self.cfg.agent_brief, console=self.cfg.agent_console, lifetime_bound=bool(self.agent.job))

    def _install_signals(self):
        prev = {}
        inherit = self.cfg.agent and self.cfg.agent_console == "inherit"

        def handler(_sig, _frame):
            self.request_stop()

        if threading.current_thread() is not threading.main_thread():
            return lambda: None
        # console を agent と共有する時の Ctrl+C は agent（対話中の中断）宛て。Launcher は無視して agent の終了に追従する
        prev[signal.SIGINT] = signal.signal(signal.SIGINT, signal.SIG_IGN if inherit else handler)
        for name in ("SIGTERM", "SIGBREAK"):
            s = getattr(signal, name, None)
            if s is not None:
                try:
                    prev[s] = signal.signal(s, handler)
                except (OSError, ValueError):
                    pass

        def restore():
            for s, h in prev.items():
                try:
                    signal.signal(s, h)
                except (OSError, ValueError):
                    pass
        return restore

    def _warn_upstream_env(self):
        """OpenMontage は自分の .env も読む。そこに有料 provider の鍵があれば Launcher では外せないので警告する（値は読まない）"""
        root = self.cfg.openmontage_root
        if not root:
            return
        p = root / ".env"
        try:
            names = [ln.split("=", 1)[0].strip() for ln in p.read_text(encoding="utf-8", errors="replace").splitlines()
                     if "=" in ln and not ln.lstrip().startswith("#") and ln.split("=", 1)[1].strip()]
        except OSError:
            return
        paid = [n for n in names if PAID_PROVIDER_ENV.search(n.upper()) and not n.upper().endswith(("_REGION", "_BASE_URL"))]
        if paid:
            self.log.emit("warning", message=f"OpenMontage の .env に有料 provider の鍵名があります（{', '.join(paid)}）。"
                                             "Launcher は .env を変更しません。MA-17 迂回を防ぐには Human が .env から外してください")

    # ---------- recovery / control

    def _recover(self):
        """前回落ちた時に処理中だったものを再開する（成功済みの candidate は cache で呼び直さない）"""
        for key, e in self.state.entries().items():
            if e.get("status") == "in_flight":
                self.state.update(key, status="pending", next_retry_at=0, recovered=True)
                self.log.emit("recovered", key=key)

    def _consume_control(self):
        d = self.cfg.control_dir
        try:
            files = [p for p in d.iterdir() if p.name.startswith("retry__") and p.suffix == ".json"]
        except OSError:
            return
        for p in files:
            project_id = p.stem[len("retry__"):]
            try:
                p.unlink()
            except OSError:
                continue
            self._apply_retry(project_id)

    def _apply_retry(self, project_id):
        self.log.emit("retry_requested", project_id=project_id)
        for key, e in self.state.entries().items():
            if e.get("project_id") == project_id:
                # identity を消す＝次の走査で必ず判定し直す。cache も捨てる（Human が明示的にやり直しを求めた）
                self.state.update(key, identity=None, cache={}, status="retry_requested", retry_round=0)
                self.scanner.forget(e.get("path"))
        self.scanner.last_full = 0.0

    # ---------- change handling

    def _on_change(self, ch):
        if ch.stage in LATE_STAGES:
            self._on_late_stage(ch)
            return
        if ch.stage == pf.FALLBACK_GATE_STAGE and (ch.path.parent / f"checkpoint_{pf.GATE_STAGE}.json").exists():
            return  # proposal を持つ pipeline では proposal が Decision Point
        try:
            data = ch.path.read_bytes()   # 1 回で読んで閉じる
            cp = pf.parse_checkpoint_bytes(data, ch.path.name)
        except FileNotFoundError:
            self.scanner.forget(ch.path)
            return
        except pf.CheckpointError as e:
            self.scanner.forget(ch.path)   # 書き込み途中の可能性。次の tick で読み直す
            self.log.emit("invalid_checkpoint", key=ch.key, error=str(e))
            return
        status = cp.get("status")
        if status not in ("awaiting_human", "completed"):
            return  # in_progress / failed はまだ gate ではない
        identity = pf.plan_identity(cp)
        rec = self.state.get(ch.key) or {}
        if rec.get("identity") == identity and rec.get("status") in ("done", "failed", "pending", "late", "stale"):
            self._count("duplicates")
            self.log.emit("duplicate_skipped", key=ch.key, identity=identity, status=status, record=rec.get("status"))
            if rec.get("checkpoint_status") != status:
                self.state.update(ch.key, checkpoint_status=status)
            return
        if status == "completed":
            late = pf.later_stage_checkpoints(ch.path)
            age = self.clock() - ch.mtime_ns / 1e9
            if late or age > self.cfg.recovery_max_age_s:
                kind = "late" if late else "stale"
                self.state.update(ch.key, project_id=ch.project_id, stage=ch.stage, path=str(ch.path), identity=identity,
                                  status=kind, overall="human-review", checkpoint_status=status, later_stages=late)
                self.log.emit("late_checkpoint" if late else "stale_skipped", key=ch.key, later_stages=late)
                return
            # gate は承認済みだが後段はまだ：assets の前に判定を出す価値がある（有料 tool はまだ動いていない）
        detected_at = self.clock()
        latency_ms = max(0, round((detected_at - ch.mtime_ns / 1e9) * 1000))
        self.log.emit("checkpoint_detected", key=ch.key, status=status, identity=identity, detect_latency_ms=latency_ms,
                      gate_already_approved=status == "completed" or None)
        self._submit(ch.key, ch, cp, identity, detected_at, latency_ms)

    def _on_late_stage(self, ch):
        if ch.mtime_ns / 1e9 < (self.started_at or 0):
            return  # Launcher 起動前の古い段階は警告しない
        gate = next((self.state.get(f"{ch.project_id}/{s}") for s in pf.GATE_STAGES if self.state.get(f"{ch.project_id}/{s}")), None)
        key = f"{ch.project_id}/{ch.stage}"
        if gate is None or gate.get("status") not in ("done",):
            self.log.emit("paid_stage_without_decision", key=key, gate_status=(gate or {}).get("status"))
            return
        handoff = gate.get("handoff") or []
        if handoff and ch.stage == "assets":
            self.log.emit("paid_stage_with_handoff", key=key, handoff=handoff)

    def _submit(self, key, ch, cp, identity, detected_at, latency_ms):
        with self._mu:
            if key in self.inflight:
                self.dirty.add(key)   # 処理中に更新された：終わったら読み直す（合体）
                return
            fut = self.pool.submit(self._job, key, ch, cp, identity, detected_at, latency_ms)
            self.inflight[key] = fut
        fut.add_done_callback(lambda _f, k=key, p=ch.path: self._job_done(k, p))

    def _job_done(self, key, path):
        with self._mu:
            self.inflight.pop(key, None)
            redo = key in self.dirty
            self.dirty.discard(key)
        if redo:
            self.scanner.forget(path)
            self.scanner.last_full = 0.0

    def _schedule_due(self):
        now = self.clock()
        for key in self.state.due(now):
            e = self.state.get(key) or {}
            with self._mu:
                if key in self.inflight:
                    continue
            path = Path(e.get("path") or "")
            try:
                cp = pf.parse_checkpoint_bytes(path.read_bytes(), path.name)
            except (OSError, pf.CheckpointError):
                self.state.update(key, status="failed", overall="human-review", last_error_codes=["CHECKPOINT_GONE"])
                continue
            identity = pf.plan_identity(cp)
            ch = Change(key=key, project_id=e.get("project_id"), stage=e.get("stage"), path=path, mtime_ns=0, size=0)
            self._submit(key, ch, cp, identity, now, None)

    # ---------- job

    def _decide_with_retry(self, key, cache, errors):
        def decide(req, env=None):
            corr = om.build_paid_generation_gate_request(req)["correlation_id"]
            hit = cache.get(corr)
            if hit is not None:
                self._count("cache_hits")
                self.log.emit("decision_cache_hit", key=key, correlation_id=corr)
                route = hit.get("route", "human-review")
                return {"decision_type": om.DECISION_TYPE, "proceed_automatically": False, "paid_execution": om.PAID_EXECUTION,
                        "openmontage_builtin_paid_tools": "forbidden", **hit,
                        "next_step": om.NEXT_STEPS.get(route, om.NEXT_STEPS["human-review"]), "cached": True}, None
            attempt = 0
            while True:
                with self.gw_sem:
                    t0 = time.perf_counter()
                    interp, envelope = self.decide_fn(req, env=self.cfg.gateway_env)
                    ms = round((time.perf_counter() - t0) * 1000)
                self._count("gateway_calls")
                code = interp.get("error_code") if interp.get("status") != "decided" else None
                self.log.emit("gateway_call", key=key, correlation_id=corr, capability=req.get("capability"),
                              tool=req.get("tool"), latency_ms=ms, status=interp.get("status"), route=interp.get("route"),
                              tier=interp.get("tier"), confidence=interp.get("confidence"),
                              resolved_by=interp.get("resolved_by"), external_engine_reached=interp.get("external_engine_reached"),
                              request_id=interp.get("request_id"), environment=interp.get("environment"), error_code=code)
                if code in IMMEDIATE_RETRY_CODES and attempt < len(self.cfg.immediate_backoff_s):
                    self.log.emit("decision_retry", key=key, code=code, attempt=attempt + 1)
                    self.sleep(self.cfg.immediate_backoff_s[attempt])
                    attempt += 1
                    continue
                if code is None:
                    cache[corr] = _slim(interp)
                else:
                    errors.append(code)
                interp = dict(interp, latency_ms=ms)
                return interp, envelope
        return decide

    def _job(self, key, ch, cp, identity, detected_at, latency_ms):
        rec = self.state.get(key) or {}
        same_plan = rec.get("identity") == identity
        cache = dict(rec.get("cache") or {})   # 計画が変わっても、変わっていない candidate の判定は再利用する
        retry_round = (rec.get("retry_round") or 0) if same_plan and rec.get("status") == "pending" else 0
        self.state.update(key, project_id=ch.project_id, stage=ch.stage, path=str(ch.path), identity=identity,
                          status="in_flight", checkpoint_status=cp.get("status"), checkpoint_timestamp=cp.get("timestamp"),
                          detected_at=datetime.fromtimestamp(detected_at, timezone.utc).isoformat(timespec="milliseconds"))
        errors = []
        t0 = time.perf_counter()
        try:
            report = pf.run_preflight_checkpoint(cp, ch.path, decide=self._decide_with_retry(key, cache, errors),
                                                 max_workers=self.cfg.gateway_concurrency)
        except Exception as e:  # noqa: BLE001 - 想定外でも Launcher 全体は止めない。この gate だけ human-review
            self.state.update(key, status="failed", overall="human-review", last_error_codes=[type(e).__name__])
            self.log.emit("decision_failed", key=key, codes=[type(e).__name__], error=str(e)[:300])
            return
        preflight_ms = round((time.perf_counter() - t0) * 1000)
        deferrable = [c for c in errors if c in DEFERRED_RETRY_CODES or c in IMMEDIATE_RETRY_CODES]
        fatal = [c for c in errors if c not in DEFERRED_RETRY_CODES and c not in IMMEDIATE_RETRY_CODES]
        backoff = self.cfg.deferred_backoff_s
        if deferrable and not fatal and retry_round < len(backoff):
            status, next_at = "pending", self.clock() + backoff[retry_round]
        elif errors:
            status, next_at = "failed", None
        else:
            status, next_at = "done", None
        handoff = [h["tool"] or h["capability"] for h in report["handoff_to_en_generate"]]
        launcher_meta = {
            "launcher": LAUNCHER_ID, "launcher_version": LAUNCHER_VERSION, "status": status,
            "detected_at": datetime.fromtimestamp(detected_at, timezone.utc).isoformat(timespec="milliseconds"),
            "decided_at": now_iso(), "detect_latency_ms": latency_ms, "preflight_ms": preflight_ms,
            "gateway_error_codes": errors, "retry_round": retry_round,
            "next_retry_at": datetime.fromtimestamp(next_at, timezone.utc).isoformat() if next_at else None,
            "note": "この報告は OpenMontage の gate の承認でも有料生成の承認でもない。有料生成は /en-generate（MA-17）の Human-only 承認だけ",
        }
        report["launcher"] = launcher_meta
        rpath = self._write_report(ch.project_id, ch.stage, report)
        summary = ", ".join(f"{(d['tool'] or d['capability'])}:{d['interpretation']['route']}"
                            f"({d['interpretation'].get('resolved_by') or d['interpretation'].get('error_code')})"
                            for d in report["decisions"]) or "生成系なし"
        self.state.update(key, status=status, overall=report["overall"], handoff=handoff,
                          request_ids=[d["interpretation"].get("request_id") for d in report["decisions"] if d["interpretation"].get("request_id")],
                          routes={(d["tool"] or d["capability"]): d["interpretation"]["route"] for d in report["decisions"]},
                          cache=cache, retry_round=retry_round + (1 if status == "pending" else 0), next_retry_at=next_at,
                          last_error_codes=errors, decided_at=launcher_meta["decided_at"], preflight_ms=preflight_ms,
                          detect_latency_ms=latency_ms, report=str(rpath))
        if status == "done":
            self._count("decided")
            self.log.emit("decision_done", key=key, overall=report["overall"], handoff=handoff, summary=summary,
                          preflight_ms=preflight_ms, report=rpath.name)
        elif status == "pending":
            self._count("pending")
            self.log.emit("decision_pending", key=key, codes=errors, retry_in_s=backoff[retry_round], report=rpath.name)
        else:
            self._count("failed")
            self.log.emit("decision_failed", key=key, codes=errors, report=rpath.name)

    def _write_report(self, project_id, stage, report):
        safe = re.sub(r"[^A-Za-z0-9._-]", "_", project_id)[:100]
        base = self.cfg.reports_dir / f"{safe}__{stage}"
        text = pf.format_text(report)
        meta = report["launcher"]
        text += (f"\n[Launcher] 状態 {meta['status']}／検知遅延 {meta['detect_latency_ms']}ms／判定 {meta['preflight_ms']}ms"
                 + (f"／一時障害 {meta['gateway_error_codes']}・再試行 {meta['next_retry_at']}" if meta["status"] == "pending" else ""))
        _atomic_write(base.with_suffix(".json"), json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        _atomic_write(base.with_suffix(".txt"), text + "\n")
        return base.with_suffix(".json")


# ------------------------------------------------------------------ status / CLI


def build_status(cfg):
    lock = SingleInstanceLock(cfg.state_dir / LOCK_NAME)
    owner = lock.owner()
    running = bool(owner and _pid_alive(owner.get("pid")))
    st = StateStore(cfg.state_dir / STATE_NAME)
    entries = st.entries()
    by = {}
    for e in entries.values():
        by[e.get("status")] = by.get(e.get("status"), 0) + 1
    recent = sorted(entries.items(), key=lambda kv: kv[1].get("updated_at", ""), reverse=True)[:10]
    return {
        "launcher": LAUNCHER_ID, "version": LAUNCHER_VERSION, "running": running,
        "pid": owner.get("pid") if running else None, "projects_dir": str(cfg.projects_dir),
        "state_dir": str(cfg.state_dir), "counts": by,
        "recent": [{"key": k, "status": e.get("status"), "overall": e.get("overall"), "handoff": e.get("handoff"),
                    "decided_at": e.get("decided_at"), "next_retry_at": e.get("next_retry_at"), "report": e.get("report")}
                   for k, e in recent],
    }


def format_status(s):
    lines = [f"E-NEXUS OpenMontage Launcher v{s['version']}：{'稼働中 pid=' + str(s['pid']) if s['running'] else '停止中'}",
             f"監視: {s['projects_dir']}", f"件数: {s['counts'] or '（まだ判定なし）'}"]
    for r in s["recent"]:
        extra = f" 有料候補={r['handoff']}" if r.get("handoff") else ""
        lines.append(f"- {r['key']}: {r['status']} / {r['overall']}{extra}  {r.get('decided_at') or ''}")
    return "\n".join(lines)


def _parser():
    p = argparse.ArgumentParser(prog="enexus_openmontage_launcher", description="E-NEXUS OpenMontage Launcher（DEV）")
    p.add_argument("command", nargs="?", default="run", choices=["run", "watch", "scan-once", "status", "retry", "init"])
    p.add_argument("target", nargs="?", help="retry の project_id")
    p.add_argument("--openmontage-root")
    p.add_argument("--projects-dir")
    p.add_argument("--state-dir")
    p.add_argument("--agent", help="'claude'（既定）/ 'none' / argv の JSON 配列")
    p.add_argument("--agent-console", choices=["new", "inherit"])
    p.add_argument("--capture-agent-output", action="store_true")
    p.add_argument("--no-brief", action="store_true")
    p.add_argument("--poll-s", type=float)
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--json", action="store_true")
    return p


def main(argv=None):
    argv = sys.argv[1:] if argv is None else list(argv)
    agent_args = []
    if "--" in argv:
        i = argv.index("--")
        argv, agent_args = argv[:i], argv[i + 1:]
    args = _parser().parse_args(argv)
    args.agent_args = agent_args
    args.mode = {"run": "run", "watch": "watch", "scan-once": "watch"}.get(args.command, "watch")
    out = sys.stdout
    try:
        if hasattr(out, "reconfigure"):
            out.reconfigure(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        pass
    try:
        if args.command == "init":
            if not args.openmontage_root:
                raise ConfigError("init には --openmontage-root が必要です")
            root = Path(args.openmontage_root).resolve()
            if not (root / "lib" / "checkpoint.py").is_file():
                raise ConfigError(f"OpenMontage の clone に見えません: {root}")
            state_dir = Path(args.state_dir or DEFAULT_STATE_DIR).resolve()
            doc = load_local_config(state_dir)
            doc.update({"openmontage_root": str(root), "agent": args.agent or doc.get("agent", "claude")})
            _atomic_write(state_dir / CONFIG_NAME, json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
            out.write(f"保存しました: {state_dir / CONFIG_NAME}（local 専用・git 管理外）\n")
            return 0
        cfg = build_config(args)
        if args.command == "status":
            s = build_status(cfg)
            out.write((json.dumps(s, ensure_ascii=False, indent=2) if args.json else format_status(s)) + "\n")
            return 0
        if args.command == "retry":
            if not args.target:
                raise ConfigError("retry には project_id が必要です")
            s = build_status(cfg)
            if s["running"]:
                cfg.control_dir.mkdir(parents=True, exist_ok=True)
                _atomic_write(cfg.control_dir / f"retry__{args.target}.json", json.dumps({"at": now_iso()}) + "\n")
                out.write(f"稼働中の Launcher へ再判定を依頼しました: {args.target}\n")
            else:
                st = StateStore(cfg.state_dir / STATE_NAME)
                for key, e in st.entries().items():
                    if e.get("project_id") == args.target:
                        st.update(key, identity=None, cache={}, status="retry_requested", retry_round=0)
                out.write(f"次回の起動時に再判定します: {args.target}\n")
            return 0
        launcher = Launcher(cfg)
        if args.command == "scan-once":
            return launcher.scan_once()
        return launcher.run()
    except ConfigError as e:
        out.write(f"[E-NEXUS OpenMontage Launcher] 起動できません：{e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())
