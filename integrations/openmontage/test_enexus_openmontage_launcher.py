"""OpenMontage Launcher のテスト（stdlib unittest）。

    python -m unittest discover -s integrations/openmontage -p "test_*.py"

- 監視（新規 / 更新 / 承認の書き直し / tmp / history / 不正 JSON / in_progress）
- 重複防止（計画 identity）・candidate 単位の判定再利用・restart recovery・lock
- retry（即時：BUSY / 遅延：TIMEOUT / 再試行しない：ENVIRONMENT_MISMATCH）・上限
- 同時実行の上限・scene_plan gate・後段 checkpoint の警告
- agent process の lifecycle（自動検知・異常終了・停止）と env から有料 provider 鍵を外すこと
- Human-only 不変条件（承認・実行を意味しない報告）・OpenMontage の project dir / clone へ書かない
- 実 adapter + fake Gateway（consumer-kit）の往復

実 Decision Engine・本物の usage.jsonl には触れない（module 全体で EDL_HOME を fake Gateway、EDL_USAGE_PATH を tmp に向け、
終了時に本物の usage.jsonl の行数が変わっていないことを検査する）。
"""
import io
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import enexus_openmontage_decision as om
import enexus_openmontage_launcher as la
import enexus_openmontage_preflight as pf

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
FIX = HERE / "fixtures"
FAKE_GATEWAY = REPO / "consumer-kit" / "conformance" / "fake-gateway"
REAL_USAGE = REPO / "data" / "usage" / "usage.jsonl"

_env_patch = None
_usage_before = None
_tmp_usage = None


def _lines(p):
    try:
        with open(p, encoding="utf-8") as f:
            return sum(1 for _ in f)
    except FileNotFoundError:
        return 0


def setUpModule():
    global _env_patch, _usage_before, _tmp_usage
    _usage_before = _lines(REAL_USAGE)
    _tmp_usage = Path(tempfile.mkdtemp(prefix="om-launcher-usage-")) / "usage.jsonl"
    # 何かの経路で実 adapter が呼ばれても実 Gateway / 実 Jev / 本物の usage へ届かないようにする
    _env_patch = mock.patch.dict(os.environ, {"EDL_HOME": str(FAKE_GATEWAY), "EDL_FAKE_CASE": "ok-human-tier",
                                              "EDL_USAGE_PATH": str(_tmp_usage), "EDL_ALLOW_NETWORK": "false"})
    _env_patch.start()


def tearDownModule():
    _env_patch.stop()
    assert _lines(REAL_USAGE) == _usage_before, "test が本物の usage.jsonl に書き込んだ"


# ------------------------------------------------------------------ helpers

def write_cp(projects, project_id, stage, status, artifacts, pipeline="cinematic", ts=None):
    """OpenMontage と同じ書き方（.json.tmp へ書いて os.replace）"""
    d = Path(projects) / project_id
    d.mkdir(parents=True, exist_ok=True)
    cp = {"version": "1.0", "project_id": project_id, "pipeline_type": pipeline, "stage": stage, "status": status,
          "timestamp": ts or f"2026-09-26T00:00:{time.perf_counter_ns() % 60:02d}.{time.perf_counter_ns() % 999999:06d}+00:00",
          "human_approved": status == "completed", "artifacts": artifacts}
    tmp = d / f"checkpoint_{stage}.json.tmp"
    tmp.write_text(json.dumps(cp, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, d / f"checkpoint_{stage}.json")
    # 同じ秒内の書き直しでも mtime/size が変わるように少し待つ（NTFS の分解能は十分だが保険）
    time.sleep(0.01)
    return d / f"checkpoint_{stage}.json"


def fixture_artifacts(name):
    return json.loads((FIX / name).read_text(encoding="utf-8"))["artifacts"]


def proposal_with(tools, promise=None):
    return {"proposal_packet": {"production_plan": {
        "pipeline": "cinematic", "render_runtime": "remotion",
        "delivery_promise": promise or {"tone_mode": "educational"},
        "stages": [{"stage": "assets", "tools": tools}]},
        "cost_estimate": {"line_items": []}}}


SUB = {"tool_name": "subtitle_gen", "role": "日本語字幕", "estimated_cost_usd": 0}
VID = {"tool_name": "video_selector", "provider": "kling", "role": "実写風の導入カット", "estimated_cost_usd": 0.35}
IMG = {"tool_name": "image_selector", "provider": "fal", "role": "背景画像", "estimated_cost_usd": 0.04}


class FakeGateway:
    """capability ごとの route を返す fake decide。errors[capability] は先頭から順に返すエラー code の列"""

    def __init__(self, routes=None, errors=None, delay=0.0):
        self.routes = routes or {"video_generation": "en-generate-hub", "image_generation": "en-generate-hub"}
        self.errors = {k: list(v) for k, v in (errors or {}).items()}
        self.delay = delay
        self.calls = []
        self.active = 0
        self.max_active = 0
        self._mu = threading.Lock()

    def __call__(self, req, env=None):
        with self._mu:
            self.calls.append(req)
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            n = len(self.calls)
            queue = self.errors.get(req["capability"])
            code = queue.pop(0) if queue else None
        try:
            if self.delay:
                time.sleep(self.delay)
            if code:
                env_ = om.unavailable_envelope(code, kind="environment_mismatch" if code == "ENVIRONMENT_MISMATCH" else "x")
                return om.interpret(env_), env_
            route = self.routes.get(req["capability"], "remotion")
            env_ = {"ok": True, "request_id": f"req_{n}", "gateway": {"environment": "dev"},
                    "decision": {"tier": "auto", "confidence": 0.9, "resolved_by": "rules" if route != "en-generate-hub" else "jev",
                                 "human_gate": {"required": False},
                                 "outcome": {"recommended_route": route, "paid_generation_required": route == "en-generate-hub"},
                                 "fallback": {"trace": []}}}
            return om.interpret(env_), env_
        finally:
            with self._mu:
                self.active -= 1


class Clock:
    def __init__(self, t=None):
        self.t = t if t is not None else time.time()

    def __call__(self):
        return self.t


def make_cfg(tmp, **kw):
    base = dict(openmontage_root=None, projects_dir=Path(tmp) / "projects", state_dir=Path(tmp) / "state", agent=None,
                console=False, immediate_backoff_s=(0.0, 0.0), deferred_backoff_s=(30.0, 120.0), poll_s=0.02,
                gateway_env={**{k: os.environ[k] for k in ("PATH", "Path", "SystemRoot") if k in os.environ},
                             "EDL_HOME": str(FAKE_GATEWAY), "EDL_FAKE_CASE": "ok-dev", "EDL_USAGE_PATH": str(_tmp_usage)})
    base.update(kw)
    base["projects_dir"].mkdir(parents=True, exist_ok=True)
    return la.LauncherConfig(**base)


def events(cfg, name=None):
    p = cfg.state_dir / la.EVENTS_NAME
    if not p.exists():
        return []
    out = [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]
    return [e for e in out if name is None or e["event"] == name]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="om-launcher-"))
        self.cfg = make_cfg(self.tmp)
        self.P = self.cfg.projects_dir
        self.launchers = []

    def tearDown(self):
        for launcher in self.launchers:
            if launcher.lock.held:
                launcher.shutdown()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def launcher(self, gw=None, cfg=None, clock=None):
        launcher = la.Launcher(cfg or self.cfg, decide=gw, stream=io.StringIO(),
                               clock=clock or time.time, sleep=lambda s: None)
        self.launchers.append(launcher)
        return launcher

    def settle(self, launcher):
        launcher.tick()
        self.assertTrue(launcher.drain(10))


# ------------------------------------------------------------------ watcher / dedupe

class DetectAndDedupeTest(Base):
    def test_free_proposal_detected_decided_and_reported(self):
        gw = FakeGateway()
        L = self.launcher(gw)
        L.start()
        write_cp(self.P, "p1", "proposal", "awaiting_human", fixture_artifacts("proposal-free-subtitle.json"))
        self.settle(L)
        e = L.state.get("p1/proposal")
        self.assertEqual((e["status"], e["overall"]), ("done", "free-path"))
        self.assertEqual(len(gw.calls), 1)
        rep = json.loads((self.cfg.reports_dir / "p1__proposal.json").read_text(encoding="utf-8"))
        self.assertEqual(rep["overall"], "free-path")
        self.assertIn("timestamp", rep["openmontage_checkpoint"])
        self.assertTrue((self.cfg.reports_dir / "p1__proposal.txt").exists())
        self.assertTrue(events(self.cfg, "checkpoint_detected"))

    def test_human_approval_rewrite_is_not_redecided(self):
        gw = FakeGateway()
        L = self.launcher(gw)
        L.start()
        art = fixture_artifacts("proposal-paid-video.json")
        write_cp(self.P, "p1", "proposal", "awaiting_human", art)
        self.settle(L)
        write_cp(self.P, "p1", "proposal", "completed", art)   # Human 承認：同じ計画を completed で書き直す
        self.settle(L)
        self.assertEqual(len(gw.calls), 2)   # video_selector + subtitle_gen の初回だけ
        self.assertEqual(L.counters["duplicates"], 1)
        self.assertEqual(L.state.get("p1/proposal")["checkpoint_status"], "completed")

    def test_updated_plan_is_redecided_reusing_unchanged_candidates(self):
        gw = FakeGateway()
        L = self.launcher(gw)
        L.start()
        write_cp(self.P, "p1", "proposal", "awaiting_human", proposal_with([SUB]))
        self.settle(L)
        write_cp(self.P, "p1", "proposal", "awaiting_human", proposal_with([SUB, VID]))
        self.settle(L)
        self.assertEqual([c["capability"] for c in gw.calls], ["subtitle", "video_generation"])  # 字幕は再利用
        e = L.state.get("p1/proposal")
        self.assertEqual(e["overall"], "paid-handoff")
        self.assertEqual(e["handoff"], ["video_selector"])
        self.assertTrue(events(self.cfg, "decision_cache_hit"))

    def test_invalid_then_valid_and_in_progress_ignored(self):
        gw = FakeGateway()
        L = self.launcher(gw)
        L.start()
        d = self.P / "p1"
        d.mkdir()
        (d / "checkpoint_proposal.json").write_text("{not json", encoding="utf-8")
        write_cp(self.P, "p2", "proposal", "in_progress", proposal_with([SUB]))
        self.settle(L)
        self.assertEqual(gw.calls, [])
        self.assertTrue(events(self.cfg, "invalid_checkpoint"))
        write_cp(self.P, "p1", "proposal", "awaiting_human", proposal_with([SUB]))
        self.settle(L)
        self.assertEqual(L.state.get("p1/proposal")["status"], "done")
        self.assertIsNone(L.state.get("p2/proposal"))

    def test_tmp_and_history_handling(self):
        sc = la.CheckpointScanner(self.P)
        d = self.P / "p1"
        (d / "history").mkdir(parents=True)
        (d / "history" / "checkpoint_proposal.json").write_text("{}", encoding="utf-8")
        self.assertEqual(sc.scan(), [])                 # history/ の下は見ない
        (d / "checkpoint_proposal.json").write_text("{}", encoding="utf-8")
        (d / "checkpoint_script.json.tmp").write_text("{}", encoding="utf-8")
        sc.last_full = 0.0
        self.assertEqual(sc.scan(), [])                 # 書き込み中（新しい tmp）は次の tick へ
        old = time.time() - 60
        os.utime(d / "checkpoint_script.json.tmp", (old, old))
        sc.last_full = 0.0
        self.assertEqual([c.key for c in sc.scan()], ["p1/proposal"])   # 残骸の tmp は無視

    def test_same_clock_tick_dir_mtime_does_not_delay_detection(self):
        # dir 作成直後に走査され、その後の書き込みで dir の mtime が変わらない（同じ時計の刻み）場合も次の tick で拾う
        sc = la.CheckpointScanner(self.P, full_rescan_s=3600)
        sc.last_full = time.monotonic()
        d = self.P / "p1"
        d.mkdir()
        m = os.stat(d).st_mtime_ns
        self.assertEqual(sc.scan(), [])
        (d / "checkpoint_proposal.json").write_text("{}", encoding="utf-8")
        os.utime(d, ns=(m, m))   # mtime を作成時と同じに戻す（同じ刻みの再現）
        self.assertEqual([c.key for c in sc.scan()], ["p1/proposal"])

    def test_scene_plan_gate_only_without_proposal(self):
        gw = FakeGateway()
        L = self.launcher(gw)
        L.start()
        scenes = {"scene_plan": {"scenes": [
            {"id": "s1", "description": "朝のキッチン", "start_seconds": 0, "end_seconds": 4,
             "required_assets": [{"type": "video", "description": "実写風の朝のキッチン", "source": "generate"},
                                 {"type": "image", "description": "ロゴ", "source": "provided"}]},
            {"id": "s2", "description": "製品の寄り", "start_seconds": 4, "end_seconds": 6,
             "required_assets": [{"type": "image", "description": "製品の静止画", "source": "generate"}]}]}}
        write_cp(self.P, "th1", "scene_plan", "awaiting_human", scenes, pipeline="talking-head")
        self.settle(L)
        e = L.state.get("th1/scene_plan")
        self.assertEqual(e["status"], "done")
        self.assertEqual(sorted(c["capability"] for c in gw.calls), ["image_generation", "video_generation"])
        video = next(c for c in gw.calls if c["capability"] == "video_generation")
        self.assertEqual(video["duration_sec"], 4)
        self.assertNotIn("tool", video)
        # proposal を持つ project の scene_plan は Decision Point にしない
        write_cp(self.P, "c1", "proposal", "completed", proposal_with([SUB]))
        n = len(gw.calls)
        self.settle(L)
        write_cp(self.P, "c1", "scene_plan", "awaiting_human", scenes)
        self.settle(L)
        self.assertEqual(len(gw.calls), n + 1)   # proposal の 1 件だけ（scene_plan は呼ばない）
        self.assertIsNone(L.state.get("c1/scene_plan"))


# ------------------------------------------------------------------ recovery / lock

class RecoveryTest(Base):
    def test_restart_does_not_redecide_but_picks_up_new(self):
        gw = FakeGateway()
        L1 = self.launcher(gw)
        L1.start()
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([SUB]))
        self.settle(L1)
        L1.shutdown()
        write_cp(self.P, "b", "proposal", "awaiting_human", proposal_with([VID]))   # Launcher 停止中に書かれた
        L2 = self.launcher(gw)
        L2.start()
        self.settle(L2)
        self.assertEqual([c["capability"] for c in gw.calls], ["subtitle", "video_generation"])
        self.assertEqual(L2.state.get("b/proposal")["status"], "done")

    def test_in_flight_at_crash_is_resumed(self):
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([SUB, VID]))
        st = la.StateStore(self.cfg.state_dir / la.STATE_NAME)
        st.update("a/proposal", project_id="a", stage="proposal", path=str(self.P / "a" / "checkpoint_proposal.json"),
                  identity="x", status="in_flight")
        gw = FakeGateway()
        L = self.launcher(gw)
        L.start()
        self.settle(L)
        self.assertEqual(L.state.get("a/proposal")["status"], "done")
        self.assertEqual(len(gw.calls), 2)

    def test_completed_gate_with_later_stage_is_late_not_called(self):
        write_cp(self.P, "old", "proposal", "completed", proposal_with([VID]))
        (self.P / "old" / "checkpoint_assets.json").write_text("{}", encoding="utf-8")
        gw = FakeGateway()
        L = self.launcher(gw)
        L.start()
        self.settle(L)
        self.assertEqual(gw.calls, [])
        self.assertEqual(L.state.get("old/proposal")["status"], "late")

    def test_single_instance_and_stale_lock(self):
        L1 = self.launcher(FakeGateway())
        L1.start()
        L2 = self.launcher(FakeGateway())
        with self.assertRaises(la.ConfigError):
            L2.start()
        L1.shutdown()
        (self.cfg.state_dir / la.LOCK_NAME).write_text(json.dumps({"pid": 999999}), encoding="utf-8")   # 死んだ pid
        L3 = self.launcher(FakeGateway())
        L3.start()
        self.assertTrue(L3.lock.held)

    def test_retry_command_redecides(self):
        gw = FakeGateway()
        L = self.launcher(gw)
        L.start()
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([SUB]))
        self.settle(L)
        with mock.patch("sys.stdout", io.StringIO()):
            rc = la.main(["retry", "a", "--state-dir", str(self.cfg.state_dir), "--projects-dir", str(self.P), "--quiet"])
        self.assertEqual(rc, 0)
        self.settle(L)
        self.assertEqual(len(gw.calls), 2)
        self.assertTrue(events(self.cfg, "retry_requested"))


# ------------------------------------------------------------------ retry / failure

class RetryTest(Base):
    def test_busy_is_retried_immediately(self):
        gw = FakeGateway(errors={"subtitle": ["GATEWAY_BUSY"]})
        L = self.launcher(gw)
        L.start()
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([SUB]))
        self.settle(L)
        self.assertEqual(L.state.get("a/proposal")["status"], "done")
        self.assertEqual(len(gw.calls), 2)
        self.assertTrue(events(self.cfg, "decision_retry"))

    def test_timeout_goes_pending_then_deferred_retry_only_failed_candidate(self):
        clock = Clock(time.time())
        gw = FakeGateway(errors={"video_generation": ["GATEWAY_TIMEOUT"]})
        L = self.launcher(gw, clock=clock)
        L.start()
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([SUB, VID]))
        self.settle(L)
        e = L.state.get("a/proposal")
        self.assertEqual((e["status"], e["overall"]), ("pending", "human-review"))
        self.assertEqual(len(gw.calls), 2)       # timeout は即時に呼び直さない（Engine が走り続けて課金しうる）
        self.settle(L)
        self.assertEqual(len(gw.calls), 2)       # 時刻前は再試行しない
        clock.t += 31
        self.settle(L)
        e = L.state.get("a/proposal")
        self.assertEqual((e["status"], e["overall"]), ("done", "paid-handoff"))
        self.assertEqual([c["capability"] for c in gw.calls], ["subtitle", "video_generation", "video_generation"])

    def test_deferred_retries_are_bounded_then_human_review(self):
        clock = Clock(time.time())
        gw = FakeGateway(errors={"subtitle": ["GATEWAY_TIMEOUT"] * 10})
        L = self.launcher(gw, clock=clock)
        L.start()
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([SUB]))
        for _ in range(6):
            self.settle(L)
            clock.t += 1000
        e = L.state.get("a/proposal")
        self.assertEqual((e["status"], e["overall"]), ("failed", "human-review"))
        self.assertEqual(len(gw.calls), 1 + len(self.cfg.deferred_backoff_s))

    def test_environment_mismatch_is_not_retried(self):
        gw = FakeGateway(errors={"subtitle": ["ENVIRONMENT_MISMATCH"]})
        L = self.launcher(gw)
        L.start()
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([SUB]))
        self.settle(L)
        self.assertEqual(L.state.get("a/proposal")["status"], "failed")
        self.assertEqual(len(gw.calls), 1)

    def test_unexpected_exception_isolated_to_one_gate(self):
        def boom(req, env=None):
            raise RuntimeError("boom")
        L = self.launcher(boom)
        L.start()
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([SUB]))
        self.settle(L)
        self.assertEqual(L.state.get("a/proposal")["status"], "failed")
        L.tick()   # Launcher 自体は動き続ける


class ConcurrencyTest(Base):
    def test_parallel_projects_bounded_gateway_concurrency(self):
        gw = FakeGateway(delay=0.1)
        L = self.launcher(gw)
        L.start()
        for i in range(5):
            write_cp(self.P, f"p{i}", "proposal", "awaiting_human", proposal_with([SUB, VID]))
        t0 = time.perf_counter()
        self.settle(L)
        elapsed = time.perf_counter() - t0
        self.assertEqual(len(gw.calls), 10)
        self.assertLessEqual(gw.max_active, self.cfg.gateway_concurrency)
        self.assertGreaterEqual(gw.max_active, 2)          # 直列にしていない
        self.assertLess(elapsed, 10 * 0.1)                  # 直列（1.0s）より速い
        self.assertTrue(all(L.state.get(f"p{i}/proposal")["status"] == "done" for i in range(5)))


# ------------------------------------------------------------------ invariants

class InvariantTest(Base):
    def _snapshot(self, root):
        return sorted((str(p.relative_to(root)), p.stat().st_size, p.stat().st_mtime_ns) for p in Path(root).rglob("*") if p.is_file())

    def test_never_writes_into_openmontage_projects_or_clone(self):
        clone = self.tmp / "clone"
        (clone / "lib").mkdir(parents=True)
        (clone / "AGENT_GUIDE.md").write_text("upstream", encoding="utf-8")
        cfg = make_cfg(self.tmp, openmontage_root=clone)
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([SUB, VID]))
        before = (self._snapshot(self.P), self._snapshot(clone))
        L = self.launcher(FakeGateway(), cfg=cfg)
        L.start()
        self.settle(L)
        L.shutdown()
        self.assertEqual((self._snapshot(self.P), self._snapshot(clone)), before)

    def test_report_is_not_an_approval(self):
        L = self.launcher(FakeGateway())
        L.start()
        write_cp(self.P, "a", "proposal", "awaiting_human", proposal_with([VID]))
        self.settle(L)
        rep = json.loads((self.cfg.reports_dir / "a__proposal.json").read_text(encoding="utf-8"))
        self.assertIs(rep["proceed_automatically"], False)
        self.assertIs(rep["openmontage_gate_touched"], False)
        self.assertEqual(rep["openmontage_builtin_paid_tools"], "forbidden")
        self.assertTrue(rep["paid_execution"].startswith("human-only"))
        self.assertEqual(rep["handoff_to_en_generate"][0]["to"], "/en-generate（MA-17）")
        text = json.dumps(rep)
        for k in ('"approved"', '"human_approved"', '"approve"', '"execute"', '"run_approved"'):
            self.assertNotIn(k, text)
        for d in rep["decisions"]:
            self.assertIs(d["interpretation"]["proceed_automatically"], False)

    def test_child_env_strips_paid_provider_and_engine_keys_but_keeps_free(self):
        # engine 用の名前は Gateway の manifest から読む（本物の repo の policies/gateway/engine-env.json）
        self.cfg.gateway_env = {"EDL_HOME": str(REPO)}
        base = {"PATH": "p", "FAL_KEY": "x", "OPENAI_API_KEY": "x", "WAVESPEED_API_KEY": "x", "PEXELS_API_KEY": "x",
                "PIXABAY_API_KEY": "x", "HF_TOKEN": "x", "JEV_API_KEY": "x", "EDL_ALLOW_NETWORK": "true", "AI_GATEWAY_API_KEY": "x"}
        env, stripped = la.child_env(base, self.cfg, self.cfg.reports_dir)
        for k in ("FAL_KEY", "OPENAI_API_KEY", "WAVESPEED_API_KEY", "JEV_API_KEY", "EDL_ALLOW_NETWORK", "AI_GATEWAY_API_KEY"):
            self.assertNotIn(k, env)
        for k in ("PATH", "PEXELS_API_KEY", "PIXABAY_API_KEY", "HF_TOKEN"):
            self.assertIn(k, env)
        self.assertEqual(env["OPENMONTAGE_PROJECTS_DIR"], str(self.cfg.projects_dir))
        self.assertEqual(env[la.CHILD_REPORTS_ENV], str(self.cfg.reports_dir))
        self.assertEqual(len(stripped), 6)

    def test_non_dev_environment_refuses_to_start(self):
        for v in ("staging", "production"):
            with self.assertRaises(la.ConfigError):
                la.build_config(None, {"EDL_ENVIRONMENT": v, "OPENMONTAGE_PROJECTS_DIR": str(self.P)})

    def test_source_has_no_openmontage_import_and_no_engine_names(self):
        src = Path(la.__file__).read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"^\s*(from|import)\s+(tools|lib|schemas|backlot)\b", src, re.M))
        self.assertIsNone(re.search(r"JEV_|AI_GATEWAY_|typesafe|vercel", src, re.I))

    def test_agent_brief_keeps_human_only_boundary_and_is_cmd_safe(self):
        b = la.agent_brief(self.cfg.reports_dir)
        self.assertIn("MA-17", b)
        self.assertIn("must NOT run inside OpenMontage", b)
        self.assertIn("not an approval", b)
        for ch in '"%^&|<>\n':
            self.assertNotIn(ch, b)


# ------------------------------------------------------------------ agent lifecycle（本物の子 process）

AGENT_SCRIPT = r"""
import json, os, sys, time
from pathlib import Path
projects = Path(os.environ["OPENMONTAGE_PROJECTS_DIR"])
reports = Path(os.environ["ENEXUS_OPENMONTAGE_REPORTS_DIR"])
d = projects / "agent-made"
d.mkdir(parents=True, exist_ok=True)
cp = {"version": "1.0", "project_id": "agent-made", "pipeline_type": "cinematic", "stage": "proposal",
      "status": "awaiting_human", "timestamp": "2026-09-26T01:02:03+00:00", "artifacts": json.loads(sys.argv[1])}
tmp = d / "checkpoint_proposal.json.tmp"
tmp.write_text(json.dumps(cp), encoding="utf-8")
os.replace(tmp, d / "checkpoint_proposal.json")
print("paid_keys_present=" + str(any(k in os.environ for k in ("FAL_KEY", "WAVESPEED_API_KEY"))))
# agent が gate 承認を求める前に報告を読む（brief の契約）
deadline = time.time() + 20
rp = reports / "agent-made__proposal.json"
while time.time() < deadline and not rp.exists():
    time.sleep(0.05)
print("report_seen=" + str(rp.exists()))
sys.exit(int(sys.argv[2]))
"""


class AgentLifecycleTest(Base):
    def _agent_cfg(self, code, extra=None):
        return make_cfg(self.tmp, agent=[sys.executable, "-c", AGENT_SCRIPT, json.dumps(proposal_with([SUB])), str(code)],
                        agent_console="inherit", capture_agent_output=True, **(extra or {}))

    def test_agent_writes_gate_and_launcher_decides_without_manual_wrapper(self):
        cfg = self._agent_cfg(0)
        gw = FakeGateway()
        with mock.patch.dict(os.environ, {"FAL_KEY": "dummy", "WAVESPEED_API_KEY": "dummy"}):
            L = self.launcher(gw, cfg=cfg)
            rc = L.run()
        self.assertEqual(rc, 0)
        self.assertEqual(L.state.get("agent-made/proposal")["status"], "done")
        out = [e["line"] for e in events(cfg, "agent_output")]
        self.assertIn("paid_keys_present=False", out)
        self.assertIn("report_seen=True", out)
        self.assertFalse(L.lock.held)

    def test_abnormal_agent_exit_is_reported_and_launcher_cleans_up(self):
        cfg = self._agent_cfg(7)
        L = self.launcher(FakeGateway(), cfg=cfg)
        rc = L.run()
        self.assertEqual(rc, 3)
        exits = events(cfg, "agent_exit")
        self.assertEqual(exits[0]["code"], 7)
        self.assertTrue(exits[0]["abnormal"])
        self.assertEqual(L.state.get("agent-made/proposal")["status"], "done")   # 落ちる前に書いた gate も判定済み

    def test_stop_request_terminates_agent(self):
        cfg = make_cfg(self.tmp, agent=[sys.executable, "-c", "import time; time.sleep(60)"], agent_console="inherit")
        L = self.launcher(FakeGateway(), cfg=cfg)
        threading.Timer(0.5, L.request_stop).start()
        t0 = time.perf_counter()
        rc = L.run()
        self.assertEqual(rc, 130)
        self.assertLess(time.perf_counter() - t0, 20)
        self.assertIsNotNone(L.agent.poll())


# ------------------------------------------------------------------ 実 adapter + fake Gateway（consumer-kit）

@unittest.skipUnless(shutil.which("node"), "node が無い")
class RealAdapterFakeGatewayTest(Base):
    def _run(self, case):
        env = dict(self.cfg.gateway_env, EDL_FAKE_CASE=case)
        cfg = make_cfg(self.tmp, gateway_env=env)
        L = self.launcher(None, cfg=cfg)   # 既定の om.decide（CLI transport）を使う
        L.start()
        write_cp(self.P, case, "proposal", "awaiting_human", proposal_with([SUB]))
        self.settle(L)
        return L.state.get(f"{case}/proposal")

    def test_ok(self):
        e = self._run("ok-dev")
        self.assertEqual(e["status"], "done")
        self.assertEqual(e["request_ids"], ["req_conformance_ok"])

    def test_bad_response_is_deferred(self):
        e = self._run("not-json")
        self.assertEqual((e["status"], e["overall"]), ("pending", "human-review"))
        self.assertEqual(e["last_error_codes"], ["GATEWAY_BAD_RESPONSE"])

    def test_environment_mismatch_fails_closed(self):
        e = self._run("environment-mismatch")
        self.assertEqual((e["status"], e["overall"]), ("failed", "human-review"))


if __name__ == "__main__":
    unittest.main()
