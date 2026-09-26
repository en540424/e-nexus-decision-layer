"""OpenMontage preflight wrapper のテスト（stdlib unittest。npm test とは別に実行する）。

    python -m unittest discover -s integrations/openmontage -p "test_*.py"

- proposal checkpoint（fixtures/ の合成 JSON）から Decision Point を拾う・写像する
- 判定の総合（free-path / paid-handoff / human-review / no-decision-point）と呼び出し上限
- OpenMontage の checkpoint・project dir へ書き込まない／承認・実行を意味しない
- 実 Gateway CLI との往復（ネットワーク無し・usage は tmp）
OpenMontage の clone が無くても通る。実 Decision Engine は呼ばない。
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock
from pathlib import Path

import enexus_openmontage_decision as om
import enexus_openmontage_preflight as pf

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
FIX = HERE / "fixtures"


def project_with(fixture, extra_checkpoints=()):
    """fixture を tmp の project dir へ checkpoint_proposal.json として置く"""
    d = Path(tempfile.mkdtemp(prefix="om-preflight-"))
    shutil.copy(FIX / fixture, d / "checkpoint_proposal.json")
    for s in extra_checkpoints:
        (d / f"checkpoint_{s}.json").write_text("{}", encoding="utf-8")
    return d


def fake_decide(route="remotion", tier="auto", status="decided"):
    calls = []

    def decide(asset_request, env=None):
        calls.append(asset_request)
        if status != "decided":
            return om.interpret(om.unavailable_envelope("GATEWAY_TIMEOUT")), None
        env_ = {"ok": True, "request_id": f"req_{len(calls)}", "gateway": {"environment": "dev"},
                "decision": {"tier": tier, "confidence": 0.9, "resolved_by": "rules", "human_gate": {"required": tier != "auto"},
                             "outcome": {"recommended_route": route, "paid_generation_required": route == "en-generate-hub"},
                             "fallback": {"trace": []}}}
        return om.interpret(env_), env_
    decide.calls = calls
    return decide


class ExtractTest(unittest.TestCase):
    def test_generation_tools_only_and_mapping(self):
        cp = pf.load_checkpoint(FIX / "proposal-paid-video.json")
        c = pf.extract_candidates(cp)
        self.assertEqual([(x["tool"], x["capability"]) for x in c],
                         [("video_selector", "video_generation"), ("subtitle_gen", "subtitle")])
        self.assertEqual(c[0]["provider"], "kling")
        self.assertEqual(c[0]["estimated_cost_usd"], 0.35)

    def test_cost_from_line_items_and_unplanned_line_items(self):
        cp = pf.load_checkpoint(FIX / "proposal-paid-video.json")
        plan = cp["artifacts"]["proposal_packet"]
        del plan["production_plan"]["stages"][0]["tools"][0]["estimated_cost_usd"]
        plan["cost_estimate"]["line_items"].append({"tool": "image_selector", "operation": "x", "estimated_usd": 0.04})
        c = {x["tool"]: x for x in pf.extract_candidates(cp)}
        self.assertEqual(c["video_selector"]["estimated_cost_usd"], 0.35)
        self.assertEqual(c["image_selector"]["capability"], "image_generation")

    def test_asset_request_keeps_ids_out_of_engine_input(self):
        cp = pf.load_checkpoint(FIX / "proposal-paid-video.json")
        packet = cp["artifacts"]["proposal_packet"]
        cand = pf.extract_candidates(cp)[0]
        cand["role"] = "C:\\Users\\someone\\secret\\clip.mp4 を参考に"
        req = om.build_paid_generation_gate_request(pf.to_asset_request(cand, packet))
        blob = json.dumps(req["input"], ensure_ascii=False)
        self.assertNotIn("Users", blob)
        self.assertNotIn("video_selector", blob)
        self.assertNotIn("kling", blob)
        self.assertEqual(req["context"]["tool"], "video_selector")
        self.assertEqual(req["context"]["provider"], "kling")
        self.assertEqual(req["input"]["style"], "cinematic")
        self.assertEqual(req["input"]["estimated_paid_cost_usd_micros"], 350000)
        self.assertNotIn("has_local_assets", req["input"])

    def test_source_required_marks_local_assets(self):
        cp = pf.load_checkpoint(FIX / "proposal-free-subtitle.json")
        req = pf.to_asset_request(pf.extract_candidates(cp)[0], cp["artifacts"]["proposal_packet"])
        self.assertIs(req["has_local_assets"], True)

    def test_invalid_checkpoints(self):
        d = Path(tempfile.mkdtemp(prefix="om-bad-"))
        with self.assertRaises(pf.CheckpointError):
            pf.load_checkpoint(d / "checkpoint_proposal.json")
        (d / "c.json").write_text(json.dumps({"stage": "assets", "artifacts": {}}), encoding="utf-8")
        with self.assertRaises(pf.CheckpointError):
            pf.load_checkpoint(d / "c.json")
        (d / "c.json").write_text("not json", encoding="utf-8")
        with self.assertRaises(pf.CheckpointError):
            pf.load_checkpoint(d / "c.json")


SCENE_PLAN_CP = {
    "version": "1.0", "project_id": "enexus-fixture-th", "stage": "scene_plan", "status": "awaiting_human",
    "pipeline_type": "talking-head", "timestamp": "2026-09-26T00:00:00+00:00",
    "artifacts": {"scene_plan": {"scenes": [
        {"id": "s1", "description": "朝のキッチン", "start_seconds": 0, "end_seconds": 3,
         "required_assets": [{"type": "video", "description": "実写風の朝のキッチン", "source": "generate"},
                             {"type": "Music", "description": "明るいBGM", "source": "generate"},
                             {"type": "image", "description": "ロゴ", "source": "provided"}]},
        {"id": "s2", "description": "製品", "start_seconds": 3, "end_seconds": 5,
         "required_assets": [{"type": "video", "description": "製品の寄り", "source": "generate"},
                             {"type": "hologram", "description": "謎の演出", "source": "generate"}]}]}},
}


class ScenePlanGateTest(unittest.TestCase):
    def test_generate_assets_grouped_by_capability(self):
        cp = pf.validate_gate_checkpoint(json.loads(json.dumps(SCENE_PLAN_CP)))
        c = {x["capability"]: x for x in pf.extract_candidates(cp)}
        self.assertEqual(sorted(c), ["music_generation", "unclassified_generation", "video_generation"])
        self.assertEqual(c["video_generation"]["duration_sec"], 5)
        self.assertIn("x2", c["video_generation"]["role"])
        self.assertIsNone(c["video_generation"]["tool"])
        req = om.build_paid_generation_gate_request(pf.to_asset_request(c["unclassified_generation"]))
        self.assertEqual(req["input"]["asset_kind"], "other")
        self.assertNotIn("tool", req["context"])

    def test_scene_plan_validation(self):
        bad = dict(SCENE_PLAN_CP, artifacts={})
        with self.assertRaises(pf.CheckpointError):
            pf.validate_gate_checkpoint(bad)
        with self.assertRaises(pf.CheckpointError):
            pf.validate_gate_checkpoint(dict(SCENE_PLAN_CP, stage="assets"))

    def test_project_dir_resolves_scene_plan_when_no_proposal(self):
        d = Path(tempfile.mkdtemp(prefix="om-th-"))
        (d / "checkpoint_scene_plan.json").write_text(json.dumps(SCENE_PLAN_CP), encoding="utf-8")
        self.assertEqual(pf._resolve_checkpoint(["--project-dir", str(d)]).name, "checkpoint_scene_plan.json")
        shutil.copy(FIX / "proposal-free-subtitle.json", d / "checkpoint_proposal.json")
        self.assertEqual(pf._resolve_checkpoint(["--project-dir", str(d)]).name, "checkpoint_proposal.json")


class PlanIdentityTest(unittest.TestCase):
    def test_identity_ignores_timestamp_status_approval_but_tracks_plan(self):
        cp = pf.load_checkpoint(FIX / "proposal-paid-video.json")
        base = pf.plan_identity(cp)
        approved = dict(cp, status="completed", human_approved=True, timestamp="2026-09-27T00:00:00+00:00")
        self.assertEqual(pf.plan_identity(approved), base)
        changed = json.loads(json.dumps(cp))
        changed["artifacts"]["proposal_packet"]["production_plan"]["stages"][0]["tools"][0]["estimated_cost_usd"] = 0.7
        self.assertNotEqual(pf.plan_identity(changed), base)

    def test_parallel_preserves_order(self):
        import time as _t
        d = project_with("proposal-paid-video.json")

        def slow_first(req, env=None):
            if req["capability"] == "video_generation":
                _t.sleep(0.1)
            return fake_decide("remotion")(req)
        r = pf.run_preflight(d / "checkpoint_proposal.json", decide=slow_first, max_workers=2)
        self.assertEqual([x["tool"] for x in r["decisions"]], ["video_selector", "subtitle_gen"])
        self.assertIn("plan_identity", r["openmontage_checkpoint"])


class PreflightTest(unittest.TestCase):
    def assert_never_approval(self, r):
        self.assertIs(r["proceed_automatically"], False)
        self.assertIs(r["openmontage_gate_touched"], False)
        self.assertEqual(r["openmontage_builtin_paid_tools"], "forbidden")
        self.assertIn("human-only", r["paid_execution"])
        blob = json.dumps(r, ensure_ascii=False)
        self.assertIsNone(re.search(r'"(approved|human_approved|approval_granted|execute)"\s*:\s*true', blob))

    def test_free_path(self):
        d = project_with("proposal-free-subtitle.json")
        decide = fake_decide("remotion")
        r = pf.run_preflight(d / "checkpoint_proposal.json", decide=decide)
        self.assertEqual(r["overall"], "free-path")
        self.assertEqual(len(decide.calls), 1)
        self.assertEqual(r["handoff_to_en_generate"], [])
        self.assert_never_approval(r)

    def test_paid_candidate_is_handoff_not_approval(self):
        d = project_with("proposal-paid-video.json")
        r = pf.run_preflight(d / "checkpoint_proposal.json", decide=fake_decide("en-generate-hub", tier="auto"))
        self.assertEqual(r["overall"], "paid-handoff")
        self.assertEqual({h["to"] for h in r["handoff_to_en_generate"]}, {"/en-generate（MA-17）"})
        self.assert_never_approval(r)
        self.assertIn("有料生成の承認でもありません", pf.format_text(r))

    def test_unavailable_and_late_stage_fall_to_human(self):
        d = project_with("proposal-free-subtitle.json")
        r = pf.run_preflight(d / "checkpoint_proposal.json", decide=fake_decide(status="unavailable"))
        self.assertEqual(r["overall"], "human-review")
        self.assert_never_approval(r)
        d2 = project_with("proposal-free-subtitle.json", extra_checkpoints=("assets",))
        r2 = pf.run_preflight(d2 / "checkpoint_proposal.json", decide=fake_decide("remotion"))
        self.assertEqual(r2["overall"], "human-review")
        self.assertEqual(r2["openmontage_checkpoint"]["later_paid_stage_checkpoints"], ["assets"])

    def test_call_cap(self):
        d = project_with("proposal-paid-video.json")
        decide = fake_decide("remotion")
        r = pf.run_preflight(d / "checkpoint_proposal.json", decide=decide, max_calls=1)
        self.assertEqual(len(decide.calls), 1)
        self.assertEqual(len(r["not_evaluated"]), 1)
        self.assertEqual(r["overall"], "human-review")

    def test_no_generation_tools_makes_no_call(self):
        d = project_with("proposal-free-subtitle.json")
        cp = json.loads((d / "checkpoint_proposal.json").read_text(encoding="utf-8"))
        cp["artifacts"]["proposal_packet"]["production_plan"]["stages"].pop(0)
        (d / "checkpoint_proposal.json").write_text(json.dumps(cp), encoding="utf-8")
        decide = fake_decide()
        r = pf.run_preflight(d / "checkpoint_proposal.json", decide=decide)
        self.assertEqual(r["overall"], "no-decision-point")
        self.assertEqual(decide.calls, [])

    def test_does_not_write_into_openmontage_project(self):
        d = project_with("proposal-paid-video.json")
        before = {p.name: p.read_bytes() for p in d.iterdir()}
        pf.run_preflight(d / "checkpoint_proposal.json", decide=fake_decide("en-generate-hub"))
        self.assertEqual({p.name: p.read_bytes() for p in d.iterdir()}, before)

    def test_cli_refuses_openmontage_managed_files_before_any_gateway_call(self):
        # 拒否する呼び出しは Gateway を呼ばない（判定も usage 記録も発生させない）。万一呼んでも実 Gateway へ届かない env にする
        d = project_with("proposal-paid-video.json")
        before = (d / "checkpoint_proposal.json").read_bytes()

        def must_not_decide(*a, **k):
            raise AssertionError("Gateway must not be called for a refused --out")
        env = {k: v for k, v in os.environ.items() if not k.startswith("EDL_")}
        env["EDL_HOME"] = str(REPO / "no-such-dir")
        with mock.patch.object(om, "decide", must_not_decide), mock.patch.dict(os.environ, env, clear=True):
            for name in ("checkpoint_proposal.json", "decision_log.json", "project.json"):
                with self.subTest(out=name):
                    self.assertEqual(pf.main(["--project-dir", str(d), "--out", str(d / name)]), 2)
        self.assertEqual((d / "checkpoint_proposal.json").read_bytes(), before)
        self.assertFalse((d / "decision_log.json").exists())

    def test_source_has_no_openmontage_import_and_no_engine_names(self):
        src = Path(pf.__file__).read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"^\s*(from|import)\s+(tools|lib|schemas)\b", src, re.M))
        self.assertIsNone(re.search(r"JEV_|AI_GATEWAY_|typesafe|vercel", src, re.I))


class RealGatewayRoundTripTest(unittest.TestCase):
    def test_free_fixture_through_real_gateway_without_network(self):
        usage = Path(tempfile.mkdtemp(prefix="edl-om-pf-")) / "usage.jsonl"
        env = {k: os.environ[k] for k in ("PATH", "Path", "SystemRoot") if k in os.environ}
        env.update({"EDL_HOME": str(REPO), "EDL_USAGE_PATH": str(usage)})
        d = project_with("proposal-free-subtitle.json")
        r = pf.run_preflight(d / "checkpoint_proposal.json", env=env)
        self.assertEqual(r["overall"], "free-path")
        i = r["decisions"][0]["interpretation"]
        self.assertEqual(i["route"], "remotion")
        self.assertEqual(i["resolved_by"], "rules")
        self.assertIs(i["external_engine_reached"], False)
        self.assertEqual(i["environment"], "dev")
        row = json.loads(usage.read_text(encoding="utf-8").strip().splitlines()[-1])
        self.assertEqual(row["application_id"], "openmontage")
        self.assertEqual(row["environment"], "dev")

    def test_cli_entrypoint_text(self):
        usage = Path(tempfile.mkdtemp(prefix="edl-om-pf-cli-")) / "usage.jsonl"
        env = {k: os.environ[k] for k in ("PATH", "Path", "SystemRoot") if k in os.environ}
        env.update({"EDL_HOME": str(REPO), "EDL_USAGE_PATH": str(usage)})
        d = project_with("proposal-free-subtitle.json")
        p = subprocess.run([os.sys.executable, pf.__file__, "--project-dir", str(d), "--text"],
                           capture_output=True, env=env, timeout=60, cwd=str(HERE))
        self.assertEqual(p.returncode, 0, p.stdout.decode("utf-8", "replace"))
        out = p.stdout.decode("utf-8")
        self.assertIn("free-path", out)
        self.assertIn("有料生成の承認でもありません", out)


if __name__ == "__main__":
    unittest.main()
