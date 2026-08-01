# Little Alphaxiv v0.1.4 promo video

This folder contains the reproducible capture and Remotion composition for the
Chinese v0.1.4 promotional video.

## Prerequisites

- The Docker deployment is healthy at `http://127.0.0.1:8000`.
- Python commands use `C:\Users\Delig\.conda\envs\Agent_env\python.exe`.
- Playwright Chromium is installed in that environment.
- `edge-tts` is installed in that environment for narration generation.

## Build

```powershell
cd tools\promo_v014
npm install
& 'C:\Users\Delig\.conda\envs\Agent_env\python.exe' scripts\capture_promo.py
& 'C:\Users\Delig\.conda\envs\Agent_env\python.exe' scripts\generate_audio.py
npm run still
npm run render
& 'C:\Users\Delig\.conda\envs\Agent_env\python.exe' scripts\normalize_video.py
```

Generated intermediates stay under `public/raw/` and `public/generated/`.
The checked-in deliverables are written to `example_demo/`.

`normalize_video.py` keeps the H.264 picture stream byte-for-byte and only
normalizes the AAC mix to a web-friendly -16 LUFS / -1.5 dB true peak target.

