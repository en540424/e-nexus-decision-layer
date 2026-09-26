@echo off
rem E-NEXUS OpenMontage Launcher (Windows). Double-click this file, or run it from any directory.
rem First time only:  launch-openmontage.cmd init --openmontage-root <path to the OpenMontage clone>
rem Afterwards:       launch-openmontage.cmd            (OpenMontage + checkpoint watcher + Decision Gateway)
rem                   launch-openmontage.cmd status
setlocal
set "HERE=%~dp0"
set "PY=python"
where python >nul 2>nul || set "PY=py -3"
%PY% "%HERE%enexus_openmontage_launcher.py" %*
set "RC=%ERRORLEVEL%"
rem Keep the window open on failure when started by double-click (no arguments).
if not "%RC%"=="0" if "%~1"=="" pause
exit /b %RC%
