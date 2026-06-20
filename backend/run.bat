@echo off
REM Run the Little Alphaxiv backend proxy on Windows.
REM Usage: run.bat   (double-click or run in CMD; activates Agent_env if present)
REM
REM On Windows, PREFER run.bat over "bash run.sh": the `bash` command often
REM resolves to WSL, whose Python 3.8 cannot parse the backend's PEP 604 union
REM syntax (needs Python 3.10+). run.bat uses the Windows conda Agent_env.
REM
REM This script always `pause`s before exiting on an error, so a double-click
REM never flashes closed with an unreadable message.
setlocal enableextensions enabledelayedexpansion
cd /d "%~dp0"
title Little Alphaxiv backend

REM --- Activate the project's required env (Python 3.10) ----------------------
REM `conda activate` needs the conda shell hook loaded. Try the common conda
REM locations explicitly so this works in a plain cmd / Explorer double-click,
REM not just inside an already-initialized "Anaconda Prompt".
set "CONDA_BASE="
if exist "%USERPROFILE%\anaconda3\condabin\conda.bat" set "CONDA_BASE=%USERPROFILE%\anaconda3"
if exist "%USERPROFILE%\miniconda3\condabin\conda.bat" set "CONDA_BASE=%USERPROFILE%\miniconda3"
if exist "C:\anaconda3\condabin\conda.bat" set "CONDA_BASE=C:\anaconda3"
if exist "C:\ProgramData\miniconda3\condabin\conda.bat" set "CONDA_BASE=C:\ProgramData\miniconda3"
if exist "C:\ProgramData\anaconda3\condabin\conda.bat" set "CONDA_BASE=C:\ProgramData\anaconda3"

if defined CONDA_BASE (
  call "%CONDA_BASE%\condabin\conda.bat" activate Agent_env
) else (
  REM No conda found - fall back to whatever python is on PATH.
  echo [run.bat] WARNING: conda not found; using python on PATH.
)

REM --- Guard: refuse anything below Python 3.10 -------------------------------
REM Older Pythons (e.g. WSL's 3.8) blow up with a cryptic pydantic traceback
REM when FastAPI evaluates the backend's `str | None` route annotations.
REM We capture the version into a var and compare via SET /A, because `if
REM errorlevel` propagation after `call conda activate` is unreliable in batch.
for /f "tokens=2 delims= " %%V in ('python --version 2^>nul') do set "PYVER=%%V"
for /f "tokens=1,2 delims=." %%A in ("!PYVER!") do (
  set "PYMAJOR=%%A"
  set "PYMINOR=%%B"
)
set /a "PYNUM=PYMAJOR*100+PYMINOR" 2>nul
if !PYNUM! LSS 310 (
  echo.
  echo [run.bat] ERROR: Python 3.10+ required. Found: !PYVER!
  echo [run.bat] The backend uses PEP 604 union type syntax unsupported below 3.10.
  echo [run.bat] Fix: install conda and create Agent_env, or activate it first.
  echo.
  pause
  exit /b 1
)

REM --- Install deps if fastapi isn't importable --------------------------------
python -c "import fastapi" 2>nul
if errorlevel 1 (
  echo [run.bat] Installing dependencies...
  python -m pip install -r requirements.txt
)

REM --- Launch ------------------------------------------------------------------
echo.
echo [run.bat] Backend starting on http://127.0.0.1:8000
echo [run.bat] Keep this window open while you use the app. Press Ctrl+C to stop.
echo.
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload

REM If uvicorn exits (crash, Ctrl+C, port-in-use), don't let the window vanish.
set "UVEXIT=!errorlevel!"
echo.
echo [run.bat] uvicorn exited with code !UVEXIT!.
if not "!UVEXIT!"=="0" echo [run.bat] If it crashed, the error is above. Common cause: port 8000 already in use.
echo.
pause
exit /b !UVEXIT!
