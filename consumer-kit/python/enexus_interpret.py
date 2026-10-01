"""Gateway の envelope を Agent の次の行動へ写す参照実装（Python・Hermes 等向け。Vault MA-32-5・2026-10-02）。

Node 版 consumer-kit/node/interpret.mjs と同じ結果を返す（cases: consumer-kit/conformance/interpretation-cases.json）。
next: candidate（tier auto＝候補。許可ではない）／review／human／stop。approval は常に False。迷ったら human。
consumer はこの file をコピーして持つ（repo をまたぐ runtime import はしない）。
"""
import json
import re
import sys

_APPROVAL_KEYS = re.compile(r"^(approved|approval|approve|authorized|authorize|allow_execution|bypass_human_gate|skip_human_review)$", re.IGNORECASE)


def interpret_envelope(envelope, expected_environment="dev"):
    def human(reason):
        return {"next": "human", "approval": False, "reason": reason}

    if not isinstance(envelope, dict):
        return human("invalid_envelope")
    if envelope.get("contract_version") != "1":
        return human("unsupported_contract_version")
    if envelope.get("ok") is not True:
        failure = envelope.get("failure")
        if isinstance(failure, dict) and failure.get("policy") == "deny":
            return {"next": "stop", "approval": False, "reason": "failure_policy_deny"}
        return human("decision_unavailable")
    d = envelope.get("decision")
    if not isinstance(d, dict):
        return human("decision_missing")
    gateway = envelope.get("gateway")
    if not isinstance(gateway, dict) or gateway.get("environment") != expected_environment:
        return human("environment_mismatch")
    outcome = d.get("outcome")
    if isinstance(outcome, dict) and any(_APPROVAL_KEYS.match(str(k)) for k in outcome):
        return human("approval_like_outcome")
    gate = d.get("human_gate")
    if isinstance(gate, dict) and gate.get("required") is True:
        return human("human_gate_required")
    tier = d.get("tier")
    if tier == "human":
        return human("tier_human")
    if tier == "review":
        return {"next": "review", "approval": False, "reason": "tier_review"}
    if tier == "auto":
        return {"next": "candidate", "approval": False, "reason": "tier_auto"}
    return human("unknown_tier")


if __name__ == "__main__":
    # conformance：cases file を引数で受け、各 case の結果を JSON で出す（tests/agent-interpretation.test.mjs が Node 版と突き合わせる）
    with open(sys.argv[1], encoding="utf-8") as f:
        cases = json.load(f)["cases"]
    print(json.dumps([interpret_envelope(c["envelope"], c["expected_environment"]) for c in cases], ensure_ascii=False))
