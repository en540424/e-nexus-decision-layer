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


if __name__ == "__main__":
    unittest.main()
