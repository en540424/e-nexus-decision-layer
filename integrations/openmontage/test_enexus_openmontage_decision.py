"""OpenMontage adapter のテスト（stdlib unittest。npm test とは別に実行する）。

    python -m unittest discover -s integrations/openmontage -p "test_*.py"

- consumer-kit/conformance/transport-cases.json の全 case を fake-gateway 相手に通す（Node reference と同じ cases）
- request builder：Engine へ送る input にパス・PII・Secret・tool 名を入れない
- interpret：どの結果も承認・実行を意味しない／OpenMontage 内蔵の有料 tool へ誘導しない
- 実 Gateway CLI との往復（ネットワーク無し・usage は tmp）
実 Decision Engine は呼ばない（子 process の env に外部判断経路の設定を渡さない）。
"""
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

import enexus_openmontage_decision as om

REPO = Path(__file__).resolve().parents[2]
KIT = REPO / "consumer-kit" / "conformance"
FAKE = KIT / "fake-gateway"
CASES = json.loads((KIT / "transport-cases.json").read_text(encoding="utf-8"))


def base_env(**extra):
    env = {k: os.environ[k] for k in ("PATH", "Path", "SystemRoot") if k in os.environ}
    env["EDL_HOME"] = str(FAKE)
    env.update(extra)
    return env


REQUEST = {"decision_type": "paid-generation-gate", "application_id": "conformance", "project_id": "openmontage",
           "correlation_id": "c-1", "input": {"asset_kind": "subtitle", "purpose": "P-SENTINEL"}}


class ConformanceTest(unittest.TestCase):
    def assert_fail_closed(self, env, expect):
        self.assertIs(env["ok"], False)
        self.assertIsNone(env["decision"])
        self.assertEqual(env["error"]["code"], expect["error_code"])
        if expect.get("failure_policy"):
            self.assertEqual(env["failure"]["policy"], expect["failure_policy"])
        self.assertIs(env["failure"]["proceed_automatically"], False)

    def test_kit_version(self):
        self.assertEqual(CASES["kit_version"], om.KIT_VERSION)

    def test_gateway_cases(self):
        for c in CASES["gateway_cases"]:
            with self.subTest(case=c["id"]):
                timeout = c.get("test_timeout_ms", 10000) / 1000
                env = om.call_gateway(REQUEST, env=base_env(EDL_FAKE_CASE=c["id"]), timeout_s=timeout)
                if c["expect"]["ok"]:
                    self.assertIs(env["ok"], True)
                    self.assertEqual(env["request_id"], c["expect"]["request_id"])
                    self.assertEqual(env["gateway"]["environment"], "dev")
                else:
                    self.assert_fail_closed(env, c["expect"])

    def test_echo_stdin_and_expected_environment(self):
        env = om.call_gateway({**REQUEST, "expected_environment": "production"}, env=base_env(EDL_FAKE_CASE="echo"))
        echo = env["echo"]
        self.assertEqual(echo["argv"], CASES["echo_case"]["expect"]["argv"])
        self.assertNotIn("P-SENTINEL", json.dumps(echo["argv"]))
        self.assertEqual(echo["request"]["input"]["purpose"], "P-SENTINEL")
        self.assertEqual(echo["request"]["expected_environment"], "dev")
        self.assertEqual(echo["request"]["contract_version"], "1")

    def test_env_forwarding_profiles(self):
        parent = {k: f"v-{k}" for k in CASES["env_forwarding"]["parent_env"]}
        spec = om.load_engine_env_spec(FAKE)
        for p in CASES["env_forwarding"]["profiles"]:
            with self.subTest(profile=p["consumer"]):
                got = om.build_child_env(parent, spec, re.compile(p["never_forward"]))
                self.assertEqual(sorted(got), sorted(p["expect_forwarded"]))

    def test_openmontage_never_forward_blocks_provider_keys(self):
        parent = {k: "v" for k in CASES["env_forwarding"]["parent_env"]}
        env = om.call_gateway(REQUEST, env={**parent, **base_env(EDL_FAKE_CASE="echo")})
        keys = env["echo"]["env_keys"]
        for k in ("FAL_KEY", "WAVESPEED_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "ACCESS_TOKEN", "RANDOM_APP_SETTING"):
            self.assertNotIn(k, keys)
        self.assertIn("EDL_ALLOW_NETWORK", keys)
        self.assertIn("ENGINE_X_KEY", keys)

    def test_configuration_cases(self):
        def must_not_run(*a, **k):
            raise AssertionError("gateway must not be called")
        for c in CASES["configuration_cases"]:
            with self.subTest(case=c["id"]):
                edl = str(REPO / "no-such-dir") if c.get("edl_home") == "<nonexistent>" else str(FAKE)
                env = om.call_gateway(REQUEST, env=base_env(EDL_HOME=edl), environment=c["environment"], run=must_not_run)
                self.assert_fail_closed(env, c["expect"])

    def test_spawn_failure_is_fail_closed(self):
        def boom(*a, **k):
            raise OSError("spawn failed")
        env = om.call_gateway(REQUEST, env=base_env(), run=boom)
        self.assert_fail_closed(env, {"error_code": "GATEWAY_SPAWN_FAILED", "failure_policy": "human-required"})


class RequestBuilderTest(unittest.TestCase):
    def test_structural_input_only(self):
        r = om.build_paid_generation_gate_request({
            "capability": "video_generation", "purpose": "30秒の製品紹介の導入カット C:\\Users\\someone\\assets\\a.png",
            "style": "realistic", "duration_sec": 5, "has_reference_media": True, "has_local_assets": False,
            "estimated_cost_usd": 0.35, "tool": "kling_video", "provider": "fal", "model": "kling-v2", "pipeline_stage": "assets",
        })
        self.assertEqual(r["application_id"], "openmontage")
        self.assertEqual(r["project_id"], "openmontage")
        self.assertEqual(r["decision_type"], "paid-generation-gate")
        inp = r["input"]
        self.assertEqual(inp["asset_kind"], "scene")
        self.assertEqual(inp["style"], "photoreal")
        self.assertEqual(inp["estimated_paid_cost_usd_micros"], 350000)
        self.assertNotIn("C:\\", inp["purpose"])
        self.assertNotIn("someone", inp["purpose"])
        for k in ("tool", "provider", "model", "pipeline_stage", "capability", "estimated_cost_usd"):
            self.assertNotIn(k, inp)
        self.assertEqual(r["context"]["tool"], "kling_video")
        self.assertTrue(r["correlation_id"].startswith("openmontage:"))
        self.assertRegex(r["correlation_id"], r"^[A-Za-z0-9._:-]{1,128}$")

    def test_pii_or_secret_purpose_is_withheld(self):
        for p in ("連絡先 taro@example.com の動画", "電話 090-1234-5678 まで", "api_key=abc123 を使って", "sk-abcdefghijklmnop1234"):
            with self.subTest(p=p):
                r = om.build_paid_generation_gate_request({"capability": "image_generation", "purpose": p})
                self.assertEqual(r["input"]["purpose"], "(purpose withheld by adapter screening)")
                self.assertIs(r["context"]["purpose_withheld"], True)

    def test_unknown_values_map_to_safe_defaults(self):
        r = om.build_paid_generation_gate_request({"capability": "music_generation", "style": "???", "purpose": "", "estimated_cost_usd": -1, "duration_sec": "10"})
        self.assertEqual(r["input"]["asset_kind"], "other")
        self.assertEqual(r["input"]["style"], "unspecified")
        self.assertEqual(r["input"]["purpose"], "(purpose not given)")
        self.assertNotIn("estimated_paid_cost_usd_micros", r["input"])
        self.assertNotIn("duration_sec", r["input"])
        self.assertEqual(om.usd_to_micros(float("nan")), None)
        self.assertEqual(om.usd_to_micros(True), None)

    def test_purpose_is_clipped(self):
        r = om.build_paid_generation_gate_request({"asset_kind": "b-roll", "purpose": "あ" * 500})
        self.assertEqual(len(r["input"]["purpose"]), om.PURPOSE_MAX_CHARS)
        self.assertEqual(r["input"]["asset_kind"], "b-roll")


def ok_envelope(outcome, tier="auto", **decision):
    return {"contract_version": "1", "ok": True, "request_id": "req_x",
            "decision": {"outcome": outcome, "tier": tier, "confidence": 0.9, "resolved_by": "jev", "provider": "p",
                         "human_gate": {"required": tier != "auto"}, "fallback": {"trace": [{"adapter": "x", "status": "ok", "networked": True}]}, **decision},
            "gateway": {"environment": "dev"}}


BUILTIN_PAID_TOOL = re.compile(r"kling|runway|sora|veo|seedance|heygen|minimax|hunyuan|higgsfield|atlas|fal_|wavespeed", re.I)


class InterpretTest(unittest.TestCase):
    def assert_never_approval(self, i):
        self.assertIs(i["proceed_automatically"], False)
        self.assertEqual(i["openmontage_builtin_paid_tools"], "forbidden")
        for k in i:
            self.assertIsNone(re.search(r"approv|authori|allow|execute|run_", k), k)
        self.assertIsNone(BUILTIN_PAID_TOOL.search(i["next_step"]), i["next_step"])

    def test_auto_paid_candidate_is_a_handover_to_en_generate_not_approval(self):
        i = om.interpret(ok_envelope({"paid_generation_required": True, "human_review_required": False, "recommended_route": "en-generate-hub"}))
        self.assertEqual(i["route"], "en-generate-hub")
        self.assertIs(i["paid_candidate"], True)
        self.assertIn("/en-generate", i["next_step"])
        self.assertIn("MA-17", i["paid_execution"])
        self.assertIs(i["external_engine_reached"], True)
        self.assert_never_approval(i)

    def test_free_routes_and_escalation(self):
        for route in ("local", "remotion"):
            i = om.interpret(ok_envelope({"paid_generation_required": False, "recommended_route": route}))
            self.assertEqual(i["route"], route)
            self.assertIs(i["human_check"], False)
            self.assert_never_approval(i)
        esc = om.interpret(ok_envelope({"escalated": True, "recommended_route": "en-generate-hub"}, tier="human"))
        self.assertEqual(esc["route"], "human-review")
        self.assertIs(esc["human_check"], True)
        self.assertIsNone(esc["paid_candidate"])
        self.assert_never_approval(esc)

    def test_unknown_route_and_unavailable_fall_to_human(self):
        weird = om.interpret(ok_envelope({"recommended_route": "fal-direct"}))
        self.assertEqual(weird["route"], "human-review")
        self.assertIs(weird["human_check"], True)
        for env in (None, om.unavailable_envelope("GATEWAY_TIMEOUT"), {"ok": True, "decision": None}):
            i = om.interpret(env)
            self.assertEqual(i["status"], "unavailable")
            self.assertEqual(i["route"], "human-review")
            self.assertIs(i["human_check"], True)
            self.assert_never_approval(i)
        self.assertIn("承認ではありません", om.format_text(om.interpret(None)))

    def test_adapter_source_has_no_engine_specific_names_and_no_openmontage_import(self):
        src = Path(om.__file__).read_text(encoding="utf-8")
        self.assertIsNone(re.search(r"JEV_|AI_GATEWAY_|typesafe|vercel", src, re.I))
        self.assertIsNone(re.search(r"^\s*(from|import)\s+(tools|lib)\b", src, re.M))


class RealGatewayRoundTripTest(unittest.TestCase):
    def test_real_gateway_without_network(self):
        usage = Path(tempfile.mkdtemp(prefix="edl-om-")) / "usage.jsonl"
        env = {k: os.environ[k] for k in ("PATH", "Path", "SystemRoot") if k in os.environ}
        env.update({"EDL_HOME": str(REPO), "EDL_USAGE_PATH": str(usage)})
        i, envelope = om.decide({"capability": "subtitle", "purpose": "日本語字幕を既存動画へ焼き込む", "has_local_assets": True}, env=env)
        self.assertIs(envelope["ok"], True)
        self.assertEqual(envelope["gateway"]["environment"], "dev")
        self.assertEqual(i["status"], "decided")
        self.assertIn(i["route"], om.NEXT_STEPS)
        self.assertIs(i["external_engine_reached"], False)
        row = json.loads(usage.read_text(encoding="utf-8").strip().splitlines()[-1])
        self.assertEqual(row["application_id"], "openmontage")
        self.assertEqual(row["environment"], "dev")
        self.assertEqual(row["via"], "cli")

    def test_cli_entrypoint(self):
        usage = Path(tempfile.mkdtemp(prefix="edl-om-cli-")) / "usage.jsonl"
        env = {k: os.environ[k] for k in ("PATH", "Path", "SystemRoot") if k in os.environ}
        env.update({"EDL_HOME": str(REPO), "EDL_USAGE_PATH": str(usage)})
        p = subprocess.run([os.sys.executable, om.__file__, "--text"], input=json.dumps({"capability": "subtitle", "purpose": "字幕"}).encode("utf-8"),
                           capture_output=True, env=env, timeout=60)
        self.assertEqual(p.returncode, 0)
        self.assertIn("承認ではありません", p.stdout.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
