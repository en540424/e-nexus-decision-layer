"""E-NEXUS Consumer Integration Kit: Python HTTP transport (reference implementation, 2026-09-29 FB-05).

deploy された HTTP Gateway へ Contract v1 の request を送る。Node 版 consumer-kit/node/http-transport.mjs と同じ契約
（docs/gateway.md §9-4）。Hermes など Python の consumer はこのファイルをコピーして持つ（repo をまたぐ runtime import はしない）。

- POST <base_url>/v1/decisions・Authorization: Bearer <token>・Content-Type: application/json
- https 必須（dev の loopback http だけ例外）。token はログ・例外へ出さない
- expected_environment を上書きし、envelope の gateway.environment を照合（違えば ENVIRONMENT_MISMATCH）
- timeout 既定 35s・自動再試行しない・401/403/429/5xx/非JSON/非v1 は fail-closed（human-required）
- 標準ライブラリだけ（urllib）
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from urllib.parse import urlparse

KIT_VERSION = "1"
CONTRACT_VERSION = "1"
DEFAULT_TIMEOUT_S = 35.0
RUNTIME_ENVIRONMENTS = ("dev", "staging", "production")
_LOOPBACK = {"127.0.0.1", "::1", "localhost"}


def unavailable_envelope(code, request=None, kind="gateway_unreachable", retryable=True):
    request = request or {}
    return {
        "contract_version": CONTRACT_VERSION,
        "ok": False,
        "request_id": request.get("request_id"),
        "correlation_id": request.get("correlation_id"),
        "decision": None,
        "error": {"code": code, "kind": kind, "retryable": retryable},
        "failure": {"policy": "human-required", "human_required": True, "proceed_automatically": False},
        "gateway": None,
    }


def check_base_url(base_url, environment):
    try:
        u = urlparse(base_url)
    except ValueError:
        return False, "GATEWAY_URL_INVALID"
    if u.scheme == "https" and u.hostname:
        return True, None
    if u.scheme == "http" and u.hostname in _LOOPBACK and environment == "dev":
        return True, None
    return False, "GATEWAY_URL_INSECURE"


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


class HttpTransport:
    def __init__(self, base_url, token, environment, timeout_s=DEFAULT_TIMEOUT_S, opener=None):
        self.base_url = base_url
        self._token = token
        self.environment = environment
        self.timeout_s = timeout_s
        self._open = opener or urllib.request.urlopen

    def __repr__(self):  # token を表示しない
        return f"HttpTransport(base_url={self.base_url!r}, environment={self.environment!r})"

    def call(self, request):
        if self.environment not in RUNTIME_ENVIRONMENTS:
            return unavailable_envelope("ENVIRONMENT_UNKNOWN", request, kind="environment_config", retryable=False)
        ok, code = check_base_url(self.base_url, self.environment)
        if not ok:
            return unavailable_envelope(code, request, kind="environment_config", retryable=False)
        if not self._token:
            return unavailable_envelope("GATEWAY_TOKEN_MISSING", request, kind="environment_config", retryable=False)
        req = dict(request or {})
        req["contract_version"] = CONTRACT_VERSION
        req["expected_environment"] = self.environment
        http_req = urllib.request.Request(
            self.base_url.rstrip("/") + "/v1/decisions",
            data=json.dumps(req).encode("utf-8"),
            method="POST",
            headers={"Authorization": f"Bearer {self._token}", "Content-Type": "application/json"},
        )
        status = None
        try:
            with self._open(http_req, timeout=self.timeout_s) as res:
                status = res.status
                body = res.read()
        except urllib.error.HTTPError as err:
            status = err.code
            try:
                body = err.read()
            except Exception:  # noqa: BLE001
                body = b""
        except TimeoutError:
            return unavailable_envelope("GATEWAY_TIMEOUT", req)
        except (urllib.error.URLError, OSError) as err:
            reason = getattr(err, "reason", None)
            return unavailable_envelope("GATEWAY_TIMEOUT" if isinstance(reason, TimeoutError) else "GATEWAY_UNREACHABLE", req)
        if status in (401, 403):
            return unavailable_envelope("GATEWAY_UNAUTHORIZED", req, kind="environment_config", retryable=False)
        try:
            envelope = json.loads(body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            envelope = None
        if status == 429 and not (isinstance(envelope, dict) and envelope.get("contract_version") == CONTRACT_VERSION):
            return unavailable_envelope("GATEWAY_RATE_LIMITED", req, kind="busy", retryable=True)
        return verify_envelope(envelope, self.environment, req)
