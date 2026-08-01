"""Normalize the rendered promo mix while stream-copying the video track."""

from __future__ import annotations

import subprocess
from pathlib import Path

import imageio_ffmpeg

ROOT = Path(__file__).resolve().parents[3]
VIDEO = ROOT / "example_demo" / "little-alphaxiv-v0.1.4-promo-zh.mp4"
TEMP = VIDEO.with_name(f"{VIDEO.stem}.normalized{VIDEO.suffix}")


def main() -> None:
    if not VIDEO.exists():
        raise FileNotFoundError(VIDEO)
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    command = [
        ffmpeg,
        "-hide_banner",
        "-y",
        "-i",
        str(VIDEO),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-c:v",
        "copy",
        "-af",
        "loudnorm=I=-16:TP=-1.5:LRA=11",
        "-ar",
        "48000",
        "-c:a",
        "aac",
        "-b:a",
        "256k",
        "-movflags",
        "+faststart",
        str(TEMP),
    ]
    try:
        subprocess.run(command, check=True)
        TEMP.replace(VIDEO)
    finally:
        if TEMP.exists():
            TEMP.unlink()
    print(f"NORMALIZED {VIDEO} ({VIDEO.stat().st_size} bytes)")


if __name__ == "__main__":
    main()

