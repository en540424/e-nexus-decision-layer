"""E-NEXUS OpenMontage Watcher のログオン時自動起動（platform adapter・2026-09-26・MA-29 × MA-30）。

Human が Launcher の起動を忘れても、OpenMontage workflow の gate checkpoint が Decision Gateway を通るようにする。
watcher 本体（enexus_openmontage_launcher.py の `watch`）は OS 非依存で、ここは「ログオン時に起動し、落ちたら戻す」だけを持つ。

    Windows：Task Scheduler（Current User・管理者不要）
      trigger  = このユーザーのログオン（即時起動）＋ 登録時刻から 1 分ごとの繰り返し（無期限の TimeTrigger＝watchdog）
                 ※ LogonTrigger の繰り返しは次のログオンまで有効にならず、RestartOnFailure は kill 等の異常終了で
                   再起動しなかった（2026-09-26 実測）ため、watchdog は TimeTrigger の繰り返しで持つ
      settings = MultipleInstancesPolicy=IgnoreNew（動いている間は新しく起動しない＝落ちた時だけ 1 分以内に戻る）
                 ExecutionTimeLimit=PT0S（既定の 72 時間で止めない）・電池でも止めない・idle 終了で止めない・Hidden
      principal= InteractiveToken・LeastPrivilege（ユーザーの session で動く＝通知が届く。昇格しない）
      action   = pythonw.exe enexus_openmontage_launcher.py watch --autostart --quiet --notify（console を出さない）
      watcher は既に動いている watcher（Launcher 内の監視を含む）がいれば何もせず 0 で終わる。Launcher が終われば次の
      繰り返しで常駐 watcher が引き継ぐ
    macOS（Mac mini 移行用・未検証）：LaunchAgent（RunAtLoad・KeepAlive・ThrottleInterval 60）

CLI（enexus_openmontage_launcher.py から呼ぶ）:
    launch-openmontage.cmd autostart install     # 登録（同じ内容で上書き＝何度実行してもよい）して今すぐ起動
    launch-openmontage.cmd autostart uninstall   # 登録を削除し、常駐 watcher も止める
    launch-openmontage.cmd autostart status      # 登録状態と watcher の現在地
    launch-openmontage.cmd autostart restart     # 常駐 watcher を止めて Task から起動し直す（code 更新の反映）
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from xml.sax.saxutils import escape

import enexus_openmontage_launcher as la

TASK_NAME = "E-NEXUS OpenMontage Watcher"
LAUNCHD_LABEL = "com.enexus.openmontage-watcher"
REPEAT_INTERVAL = "PT1M"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _run(cmd, runner=None):
    runner = runner or (lambda c: subprocess.run(c, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                                 creationflags=NO_WINDOW))
    return runner(cmd)


def background_python(executable=None):
    """console を出さない interpreter（Windows は pythonw.exe）。無ければ通常の python"""
    exe = Path(executable or sys.executable)
    if os.name == "nt":
        w = exe.with_name("pythonw.exe")
        if w.is_file():
            return w
    return exe


def watcher_arguments(state_dir=None):
    args = [str(la.HERE / "enexus_openmontage_launcher.py"), "watch", "--autostart", "--quiet", "--notify"]
    if state_dir and Path(state_dir).resolve() != la.DEFAULT_STATE_DIR.resolve():
        args += ["--state-dir", str(state_dir)]
    return args


def _quote(a):
    return f'"{a}"' if (" " in a or not a) else a


def task_xml(user, python, arguments, workdir, description=None, start_boundary=None):
    """Task Scheduler の定義（XML）。既定値のままだと常駐を壊す設定（72h 制限・電池で停止・idle 終了で停止）を明示で外す"""
    desc = description or ("E-NEXUS OpenMontage Watcher（DEV）：OpenMontage の gate checkpoint を監視し Decision Gateway を自動で呼ぶ。"
                           "有料生成は行わない（MA-17 Human-only のまま）。解除は launch-openmontage.cmd autostart uninstall")
    args = " ".join(_quote(a) for a in arguments)
    start = start_boundary or time.strftime("%Y-%m-%dT%H:%M:%S")
    return f"""<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>E-NEXUS</Author>
    <Description>{escape(desc)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{escape(user)}</UserId>
      <Repetition>
        <Interval>{REPEAT_INTERVAL}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </LogonTrigger>
    <TimeTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>{start}</StartBoundary>
      <Repetition>
        <Interval>{REPEAT_INTERVAL}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{escape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{escape(str(python))}</Command>
      <Arguments>{escape(args)}</Arguments>
      <WorkingDirectory>{escape(str(workdir))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"""


def launchagent_plist(python, arguments, workdir):
    """macOS LaunchAgent（Mac mini 移行用・未検証）。KeepAlive＋ThrottleInterval で落ちても 60 秒以内に戻る"""
    items = "".join(f"\n    <string>{escape(a)}</string>" for a in [str(python), *arguments])
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>{items}
  </array>
  <key>WorkingDirectory</key>
  <string>{escape(str(workdir))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
"""


def current_user(env=None):
    env = os.environ if env is None else env
    user = env.get("USERNAME") or env.get("USER") or ""
    dom = env.get("USERDOMAIN")
    return f"{dom}\\{user}" if dom else user


# ------------------------------------------------------------------ operations（runner は test で差し替える）


def install(state_dir=None, runner=None, start=True, env=None):
    state_dir = Path(state_dir or la.DEFAULT_STATE_DIR)
    args = watcher_arguments(state_dir)
    if os.name == "nt":
        xml = task_xml(current_user(env), background_python(), args, la.HERE)
        xml_path = state_dir / "autostart" / "task.xml"
        xml_path.parent.mkdir(parents=True, exist_ok=True)
        xml_path.write_text(xml, encoding="utf-16")
        r = _run(["schtasks", "/Create", "/TN", TASK_NAME, "/XML", str(xml_path), "/F"], runner)   # /F＝上書き（冪等）
        if r.returncode != 0:
            return {"ok": False, "step": "create", "detail": (r.stdout + r.stderr).strip()[-500:]}
        if start:
            r2 = _run(["schtasks", "/Run", "/TN", TASK_NAME], runner)
            if r2.returncode != 0:
                return {"ok": False, "step": "run", "detail": (r2.stdout + r2.stderr).strip()[-500:]}
        return {"ok": True, "platform": "windows-task-scheduler", "task": TASK_NAME, "definition": str(xml_path), "started": start}
    if sys.platform == "darwin":
        plist = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
        plist.parent.mkdir(parents=True, exist_ok=True)
        plist.write_text(launchagent_plist(background_python(), args, la.HERE), encoding="utf-8")
        uid = os.getuid()
        _run(["launchctl", "bootout", f"gui/{uid}", str(plist)], runner)
        r = _run(["launchctl", "bootstrap", f"gui/{uid}", str(plist)], runner)
        return {"ok": r.returncode == 0, "platform": "macos-launchagent", "definition": str(plist), "verified": False}
    return {"ok": False, "step": "platform", "detail": f"未対応の platform: {sys.platform}（watch を常駐させる仕組みを追加してください）"}


def _stop_autostart_watcher(state_dir, runner=None, wait_s=10.0):
    """登録解除の後に残っている常駐 watcher（role=autostart）だけを止める。Launcher 内の監視（role=launcher）は止めない"""
    lock = la.SingleInstanceLock(Path(state_dir) / la.LOCK_NAME)
    if not lock.held_elsewhere():
        return {"stopped": False, "reason": "not running"}
    owner = lock.owner() or {}
    if owner.get("role") != "autostart":
        return {"stopped": False, "reason": f"running watcher is role={owner.get('role')}（止めない）"}
    pid = owner.get("pid")
    if os.name == "nt":
        _run(["taskkill", "/PID", str(pid), "/T", "/F"], runner)
    else:
        try:
            os.kill(pid, 15)
        except (ProcessLookupError, PermissionError, TypeError):
            pass
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline and lock.held_elsewhere():
        time.sleep(0.1)
    return {"stopped": not lock.held_elsewhere(), "pid": pid}


def uninstall(state_dir=None, runner=None):
    state_dir = Path(state_dir or la.DEFAULT_STATE_DIR)
    if os.name == "nt":
        _run(["schtasks", "/End", "/TN", TASK_NAME], runner)
        r = _run(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"], runner)
        deleted = r.returncode == 0
        detail = None if deleted else (r.stdout + r.stderr).strip()[-300:]
    elif sys.platform == "darwin":
        plist = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
        _run(["launchctl", "bootout", f"gui/{os.getuid()}", str(plist)], runner)
        deleted = True
        try:
            plist.unlink()
        except FileNotFoundError:
            pass
        detail = None
    else:
        deleted, detail = False, f"未対応の platform: {sys.platform}"
    stop = _stop_autostart_watcher(state_dir, runner)
    return {"ok": deleted or "cannot find" in (detail or "").lower() or "見つかりません" in (detail or ""),
            "deleted": deleted, "detail": detail, "watcher": stop}


def restart(state_dir=None, runner=None):
    """常駐 watcher（role=autostart）を止めて Task から起動し直す。登録は変えない（code を更新した時に使う）"""
    state_dir = Path(state_dir or la.DEFAULT_STATE_DIR)
    stop = _stop_autostart_watcher(state_dir, runner)
    if os.name == "nt":
        r = _run(["schtasks", "/Run", "/TN", TASK_NAME], runner)
        ok = r.returncode == 0
    elif sys.platform == "darwin":
        r = _run(["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LAUNCHD_LABEL}"], runner)
        ok = r.returncode == 0
    else:
        ok = False
    return {"ok": ok, "stopped": stop}


def task_status(runner=None):
    """登録の有無・状態・最後の実行結果（Windows）。値は表示用"""
    if os.name != "nt":
        plist = Path.home() / "Library" / "LaunchAgents" / f"{LAUNCHD_LABEL}.plist"
        return {"installed": plist.exists(), "platform": sys.platform}
    ps = (f"$t = Get-ScheduledTask -TaskName '{TASK_NAME}' -ErrorAction SilentlyContinue; if (-not $t) {{ '{{\"installed\":false}}'; exit }};"
          "$i = $t | Get-ScheduledTaskInfo; [pscustomobject]@{installed=$true; state=[string]$t.State;"
          "last_run=[string]$i.LastRunTime; last_result=$i.LastTaskResult; next_run=[string]$i.NextRunTime;"
          "action=[string]$t.Actions[0].Execute; arguments=[string]$t.Actions[0].Arguments} | ConvertTo-Json -Compress")
    r = _run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps], runner)
    try:
        return json.loads((r.stdout or "").strip().splitlines()[-1])
    except (ValueError, IndexError):
        return {"installed": None, "detail": (r.stdout + r.stderr).strip()[-300:]}


def main(args, out):
    action = args.target or "status"
    state_dir = Path(args.state_dir).resolve() if args.state_dir else la.DEFAULT_STATE_DIR
    if action == "install":
        res = install(state_dir)
        if res.get("ok"):
            # 起動したことを確かめる（Task Scheduler の起動は非同期）
            lock = la.SingleInstanceLock(state_dir / la.LOCK_NAME)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline and not lock.held_elsewhere():
                time.sleep(0.2)
            res["watcher_running"] = lock.held_elsewhere()
    elif action == "uninstall":
        res = uninstall(state_dir)
    elif action == "restart":
        res = restart(state_dir)
        lock = la.SingleInstanceLock(state_dir / la.LOCK_NAME)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline and not lock.held_elsewhere():
            time.sleep(0.2)
        res["watcher_running"] = lock.held_elsewhere()
    elif action == "status":
        import argparse
        cfg_args = argparse.Namespace(state_dir=str(state_dir), mode="watch", command="status")
        try:
            watcher = la.build_status(la.build_config(cfg_args))
        except la.ConfigError as e:
            watcher = {"error": str(e)}
        res = {"task": task_status(), "watcher": {k: watcher.get(k) for k in (
            "running", "pid", "role", "environment", "started_at", "heartbeat_at", "last_checkpoint", "last_decision",
            "recent_error", "pending", "projects_dir", "error")}}
    else:
        raise la.ConfigError("autostart は install / uninstall / status / restart のいずれかです")
    if args.json or action == "status":
        out.write(json.dumps(res, ensure_ascii=False, indent=2) + "\n")
    else:
        out.write(("完了" if res.get("ok") else "失敗") + "：" + json.dumps(res, ensure_ascii=False) + "\n")
    return 0 if res.get("ok", True) else 1
