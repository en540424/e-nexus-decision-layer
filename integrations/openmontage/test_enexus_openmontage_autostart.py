"""ログオン時自動起動（platform adapter）のテスト。

本物の Task Scheduler・launchd には登録しない（schtasks / launchctl は fake runner で受ける）。Gateway も呼ばない。
"""
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

import enexus_openmontage_autostart as au
import enexus_openmontage_launcher as la

HERE = Path(__file__).resolve().parent
NS = {"t": "http://schemas.microsoft.com/windows/2004/02/mit/task"}


class FakeRunner:
    def __init__(self, fail=None):
        self.calls = []
        self.fail = fail or set()

    def __call__(self, cmd):
        self.calls.append(list(cmd))
        rc = 1 if (cmd[0], cmd[1] if len(cmd) > 1 else "") in self.fail else 0
        return subprocess.CompletedProcess(cmd, rc, stdout="", stderr="error" if rc else "")


def text(root, path):
    return root.find(path, NS).text


class TaskDefinitionTest(unittest.TestCase):
    def setUp(self):
        xml = au.task_xml("PC\\someone", Path("C:/py/pythonw.exe"), au.watcher_arguments(), Path("C:/work dir"))
        self.root = ET.fromstring(xml.replace('encoding="UTF-16"', ""))

    def test_logon_trigger_for_current_user_with_repetition(self):
        self.assertEqual(text(self.root, "t:Triggers/t:LogonTrigger/t:UserId"), "PC\\someone")
        self.assertEqual(text(self.root, "t:Triggers/t:LogonTrigger/t:Repetition/t:Interval"), "PT1M")
        self.assertEqual(text(self.root, "t:Triggers/t:LogonTrigger/t:Repetition/t:StopAtDurationEnd"), "false")

    def test_watchdog_repeats_from_registration_time_not_only_after_next_logon(self):
        tt = "t:Triggers/t:TimeTrigger/"
        self.assertEqual(text(self.root, tt + "t:Enabled"), "true")
        self.assertRegex(text(self.root, tt + "t:StartBoundary"), r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$")
        self.assertEqual(text(self.root, tt + "t:Repetition/t:Interval"), "PT1M")
        self.assertEqual(text(self.root, tt + "t:Repetition/t:StopAtDurationEnd"), "false")
        self.assertIsNone(self.root.find(tt + "t:Repetition/t:Duration", NS))   # 無期限

    def test_no_elevation_and_user_session(self):
        self.assertEqual(text(self.root, "t:Principals/t:Principal/t:LogonType"), "InteractiveToken")
        self.assertEqual(text(self.root, "t:Principals/t:Principal/t:RunLevel"), "LeastPrivilege")

    def test_settings_that_would_silently_break_always_on_are_overridden(self):
        st = "t:Settings/"
        self.assertEqual(text(self.root, st + "t:ExecutionTimeLimit"), "PT0S")          # 既定 72h で止めない
        self.assertEqual(text(self.root, st + "t:DisallowStartIfOnBatteries"), "false")
        self.assertEqual(text(self.root, st + "t:StopIfGoingOnBatteries"), "false")
        self.assertEqual(text(self.root, st + "t:IdleSettings/t:StopOnIdleEnd"), "false")
        self.assertEqual(text(self.root, st + "t:MultipleInstancesPolicy"), "IgnoreNew")
        self.assertEqual(text(self.root, st + "t:StartWhenAvailable"), "true")
        self.assertEqual(text(self.root, st + "t:Hidden"), "true")
        self.assertEqual(text(self.root, st + "t:RestartOnFailure/t:Count"), "3")

    def test_action_runs_only_the_watcher_without_console(self):
        self.assertTrue(text(self.root, "t:Actions/t:Exec/t:Command").endswith("pythonw.exe"))
        args = text(self.root, "t:Actions/t:Exec/t:Arguments")
        self.assertIn("enexus_openmontage_launcher.py", args)
        for a in ("watch", "--autostart", "--quiet", "--notify"):
            self.assertIn(a, args)
        self.assertNotIn("run", args.split())                   # agent は起動しない
        self.assertEqual(text(self.root, "t:Actions/t:Exec/t:WorkingDirectory"), str(Path("C:/work dir")))

    def test_watcher_arguments_state_dir(self):
        self.assertNotIn("--state-dir", au.watcher_arguments())
        self.assertIn("--state-dir", au.watcher_arguments(Path(tempfile.gettempdir()) / "x"))

    def test_launchagent_plist_keeps_watcher_alive(self):
        d = plistlib.loads(au.launchagent_plist("/usr/bin/python3", au.watcher_arguments(), "/opt/w").encode("utf-8"))
        self.assertEqual(d["Label"], au.LAUNCHD_LABEL)
        self.assertTrue(d["RunAtLoad"])
        self.assertTrue(d["KeepAlive"])
        self.assertEqual(d["ThrottleInterval"], 60)
        self.assertEqual(d["ProgramArguments"][2], "watch")


@unittest.skipUnless(os.name == "nt", "Windows の Task Scheduler")
class WindowsInstallTest(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="om-autostart-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_install_is_idempotent_and_overwrites(self):
        r = FakeRunner()
        a = au.install(self.tmp, runner=r, env={"USERNAME": "someone", "USERDOMAIN": "PC"})
        b = au.install(self.tmp, runner=r, env={"USERNAME": "someone", "USERDOMAIN": "PC"})
        self.assertTrue(a["ok"] and b["ok"])
        create = [c for c in r.calls if c[:2] == ["schtasks", "/Create"]]
        self.assertEqual(len(create), 2)
        self.assertTrue(all("/F" in c and au.TASK_NAME in c for c in create))
        self.assertEqual(sum(c[:2] == ["schtasks", "/Run"] for c in r.calls), 2)
        xml = (self.tmp / "autostart" / "task.xml").read_text(encoding="utf-16")
        self.assertIn("<UserId>PC\\someone</UserId>", xml)
        self.assertIn(str(self.tmp), xml)   # 既定以外の state dir は引数で渡る

    def test_install_failure_is_reported_not_raised(self):
        r = FakeRunner(fail={("schtasks", "/Create")})
        res = au.install(self.tmp, runner=r)
        self.assertEqual((res["ok"], res["step"]), (False, "create"))
        self.assertFalse(any(c[:2] == ["schtasks", "/Run"] for c in r.calls))

    def _holder(self, role):
        code = ("import sys,time;sys.path.insert(0,sys.argv[1]);import enexus_openmontage_launcher as la;"
                "lk=la.SingleInstanceLock(la.Path(sys.argv[2])/la.LOCK_NAME);print(lk.acquire({'role':sys.argv[3]}),flush=True);time.sleep(60)")
        p = subprocess.Popen([sys.executable, "-c", code, str(HERE), str(self.tmp), role], stdout=subprocess.PIPE, text=True)
        self.assertEqual(p.stdout.readline().strip(), "True")
        return p

    def test_uninstall_deletes_task_and_stops_only_the_autostart_watcher(self):
        real = subprocess.run

        def runner(cmd):   # schtasks は fake、taskkill は本物（test が起こした process だけが対象）
            if cmd[0] == "schtasks":
                return FakeRunner()(cmd)
            return real(cmd, capture_output=True, text=True)
        p = self._holder("autostart")
        try:
            res = au.uninstall(self.tmp, runner=runner)
            self.assertTrue(res["ok"] and res["deleted"])
            self.assertTrue(res["watcher"]["stopped"])
            p.wait(10)
        finally:
            if p.poll() is None:
                p.kill()
                p.wait(10)
            p.stdout.close()
        q = self._holder("launcher")    # Launcher の対話中の監視は止めない
        try:
            res = au.uninstall(self.tmp, runner=runner)
            self.assertFalse(res["watcher"]["stopped"])
            self.assertIsNone(q.poll())
        finally:
            q.kill()
            q.wait(10)
            q.stdout.close()

    def test_uninstall_when_not_installed_is_ok(self):
        r = FakeRunner()

        def runner(cmd):
            res = r(cmd)
            if cmd[:2] == ["schtasks", "/Delete"]:
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="ERROR: The system cannot find the file specified.")
            return res
        res = au.uninstall(self.tmp, runner=runner)
        self.assertTrue(res["ok"])
        self.assertFalse(res["deleted"])

    def test_restart_runs_task_again(self):
        r = FakeRunner()
        res = au.restart(self.tmp, runner=r)
        self.assertTrue(res["ok"])
        self.assertIn(["schtasks", "/Run", "/TN", au.TASK_NAME], r.calls)
        self.assertEqual(res["stopped"]["reason"], "not running")

    def test_status_parses_task_info(self):
        def runner(cmd):
            return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps({"installed": True, "state": "Running", "last_result": 267009}), stderr="")
        s = au.task_status(runner)
        self.assertEqual((s["installed"], s["state"]), (True, "Running"))

    def test_background_python_prefers_pythonw(self):
        self.assertEqual(au.background_python().name.lower(), "pythonw.exe")


class CliTest(unittest.TestCase):
    def test_unknown_action_is_config_error(self):
        import io
        from unittest import mock
        with mock.patch("sys.stdout", io.StringIO()) as out:
            rc = la.main(["autostart", "bogus", "--state-dir", tempfile.mkdtemp(prefix="om-as-cli-")])
        self.assertEqual(rc, 1)
        self.assertIn("install / uninstall / status / restart", out.getvalue())


class MacLaunchAgentTest(unittest.TestCase):
    """2026-09-29：macOS 経路を Windows 上でも検査する（sys.platform・os.getuid・Path.home を差し替え、launchctl は fake runner）。
    実機の launchd での確認は Mac mini 到着後（Human）"""

    LAUNCHCTL_PRINT = "gui/501/com.enexus.openmontage-watcher = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tlast exit code = 0\n}\n"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="om-mac-"))
        self.state = self.tmp / "state"
        self._platform, self._home = au._platform, Path.home
        self._getuid = getattr(os, "getuid", None)
        au._platform = lambda: "darwin"
        os.getuid = lambda: 501  # Windows には無い
        Path.home = classmethod(lambda cls: self.tmp / "home")

    def tearDown(self):
        au._platform = self._platform
        Path.home = self._home
        if self._getuid is None:
            del os.getuid
        else:
            os.getuid = self._getuid
        shutil.rmtree(self.tmp, ignore_errors=True)

    def runner(self, print_rc=0):
        calls = []

        def run(cmd):
            calls.append(list(cmd))
            if cmd[:2] == ["launchctl", "print"]:
                return subprocess.CompletedProcess(cmd, print_rc, stdout=self.LAUNCHCTL_PRINT if print_rc == 0 else "", stderr="" if print_rc == 0 else "not found")
            return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")
        return run, calls

    def _install(self, run):
        return au.install(state_dir=self.state, runner=run)

    def test_install_writes_plist_with_path_and_logs_then_verifies_with_launchctl_print(self):
        run, calls = self.runner()
        r = self._install(run)
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["verified"])
        self.assertEqual(r["status"]["state"], "running")
        self.assertEqual(r["status"]["pid"], 4242)
        self.assertEqual([c[:2] for c in calls], [["launchctl", "bootout"], ["launchctl", "bootstrap"], ["launchctl", "print"]])
        self.assertEqual(calls[1][2], "gui/501")
        plist = plistlib.loads((self.tmp / "home" / "Library" / "LaunchAgents" / f"{au.LAUNCHD_LABEL}.plist").read_bytes())
        path = plist["EnvironmentVariables"]["PATH"].split(":")
        self.assertIn("/usr/bin", path)
        self.assertIn("/opt/homebrew/bin", path)
        self.assertEqual(Path(plist["StandardErrorPath"]).name, "launchd.err.log")
        self.assertNotIn("JEV_API_KEY", json.dumps(plist), "no secrets in the plist")
        self.assertEqual(set(plist["EnvironmentVariables"]), {"PATH"})

    def test_install_reports_failure_when_launchd_does_not_load_it(self):
        run, _ = self.runner(print_rc=113)
        r = self._install(run)
        self.assertFalse(r["ok"])
        self.assertFalse(r["verified"])

    def test_status_uninstall_restart_use_launchctl(self):
        run, calls = self.runner()
        st = au.task_status(runner=run)
        self.assertTrue(st["loaded"])
        self.assertEqual(st["last_exit_code"], 0)
        au.restart(state_dir=self.state, runner=run)
        self.assertIn(["launchctl", "kickstart", "-k", f"gui/501/{au.LAUNCHD_LABEL}"], calls)
        u = au.uninstall(state_dir=self.state, runner=run)
        self.assertTrue(u["ok"])
        self.assertTrue(any(c[:2] == ["launchctl", "bootout"] for c in calls))

    def test_parse_launchctl_print_tolerates_missing_fields(self):
        self.assertEqual(au.parse_launchctl_print(""), {"state": None, "pid": None, "last_exit_code": None})
        self.assertEqual(au.parse_launchctl_print("\tstate = waiting\n\tlast exit code = 78\n"), {"state": "waiting", "pid": None, "last_exit_code": 78})

    def test_launchd_path_puts_node_and_python_first_without_duplicates(self):
        p = au.launchd_path("/opt/py/bin/python3", which=lambda name: "/opt/homebrew/bin/node" if name == "node" else None).split(":")
        self.assertEqual(p[:2], ["/opt/homebrew/bin", "/opt/py/bin"])
        self.assertEqual(len(p), len(set(p)))


class PosixProcessGroupTest(unittest.TestCase):
    """headless（capture）の agent は POSIX で新しい session として起動し、stop() は group ごと止める（Windows の Job Object 相当）"""

    def test_capture_mode_starts_new_session_and_stop_kills_the_group(self):
        started, killed = {}, []

        class FakeProc:
            pid = 7777
            returncode = None
            stdout = stderr = None

            def poll(self):
                return self.returncode

            def wait(self, timeout=None):
                if killed:
                    self.returncode = -15
                    return self.returncode
                raise subprocess.TimeoutExpired("x", timeout)

        def fake_popen(argv, **kw):
            started.update(kw)
            return FakeProc()

        orig = (la._posix_group_kill, la.subprocess.Popen, getattr(la.os, "killpg", None), la.bind_child_lifetime)
        la._posix_group_kill = lambda: True
        la.subprocess.Popen = fake_popen
        la.os.killpg = lambda pid, sig: killed.append((pid, sig))
        la.bind_child_lifetime = lambda pid: None
        try:
            ap = la.AgentProcess(["agent"], cwd=".", env={}, console="none", capture=False)
            ap.start()
            self.assertNotIn("start_new_session", started, "interactive/console mode keeps the terminal's process group")
            started.clear()
            ap = la.AgentProcess(["agent"], cwd=".", env={}, console="none", capture=True)
            ap._pump = lambda *a: None
            ap.start()
            self.assertTrue(started.get("start_new_session"))
            ap.stop(grace_s=0.01)
            self.assertEqual(killed[0][0], 7777)
        finally:
            la._posix_group_kill, la.subprocess.Popen = orig[0], orig[1]
            if orig[2] is None:
                del la.os.killpg
            else:
                la.os.killpg = orig[2]
            la.bind_child_lifetime = orig[3]


if __name__ == "__main__":
    unittest.main()
