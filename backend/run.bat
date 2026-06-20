@echo off
REM Run the Little Alphaxiv backend proxy on Windows.
REM Usage: run.bat   (activates Agent_env if available, installs deps if missing)
REM
REM On Windows, PREFER run.bat over "bash run.sh": the `bash` command often
REM resolves to WSL, whose Python 3.8 cannot parse the backend's PEP 604 union
REM syntax (needs Python 3.10+). run.bat uses the Windows conda Agent_env.
setlocal
cd /d "%~dp0"

REM Activate the project's required env (Python 3.10) if conda is on PATH.
where conda >nul 2>nul && call conda activate Agent_env

REM Guard: refuse anything below Python 3.10 with a clear message instead of a
REM cryptic pydantic traceback.
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" 2>nul
if errorlevel 1 (
  echo [run.bat] ERROR: Python 3.10+ required. Found:
  python --version
  echo [run.bat] The backend uses PEP 604 union type syntax unsupported below Python 3.10.
  echo [run.bat] Fix: conda activate Agent_env  (Python 3.10)
  exit /b 1
)

REM Install deps if fastapi isn't importable.
python -c "import fastapi" 2>nul || python -m pip install -r requirements.txt

echo [run.bat] Starting uvicorn on http://127.0.0.1:8000  (Ctrl+C to quit)
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
