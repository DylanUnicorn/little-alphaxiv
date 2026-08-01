"""Generate Chinese narration segments and an original ambient music bed."""

from __future__ import annotations

import asyncio
import json
import math
import random
import wave
from array import array
from pathlib import Path

import edge_tts

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "src" / "script.zh-CN.json"
OUTPUT = ROOT / "public" / "generated"
SAMPLE_RATE = 48_000


async def generate_voiceovers(data: dict) -> None:
    voice = data["voice"]
    rate = data.get("rate", "+0%")
    for segment in data["segments"]:
        target = OUTPUT / f"voice-{segment['id']}.mp3"
        communicator = edge_tts.Communicate(
            text=segment["text"],
            voice=voice,
            rate=rate,
            volume="+0%",
            pitch="+0Hz",
        )
        await communicator.save(str(target))
        print(f"VOICE {segment['id']}: {target} ({target.stat().st_size} bytes)")


def note_frequency(midi_note: int) -> float:
    return 440.0 * (2.0 ** ((midi_note - 69) / 12.0))


def smoothstep(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3.0 - 2.0 * value)


def generate_music(duration: float) -> Path:
    """Write a quiet, copyright-clean electronic bed using only stdlib DSP."""
    total_frames = int(duration * SAMPLE_RATE)
    samples = array("h")
    rng = random.Random(1401)
    progression = [
        (57, 60, 64),  # A minor
        (53, 57, 60),  # F major
        (60, 64, 67),  # C major
        (55, 59, 62),  # G major
    ]
    master = 0.72

    for index in range(total_frames):
        t = index / SAMPLE_RATE
        chord_index = int(t // 8.0) % len(progression)
        chord_t = t % 8.0
        chord = progression[chord_index]

        chord_fade = min(smoothstep(chord_t / 1.4), smoothstep((8.0 - chord_t) / 1.4))
        pad_left = 0.0
        pad_right = 0.0
        for voice_index, midi in enumerate(chord):
            freq = note_frequency(midi)
            phase = 2.0 * math.pi * freq * t
            tone = math.sin(phase) + 0.28 * math.sin(phase * 2.0 + 0.3)
            amp = 0.030 * chord_fade
            pan = (-0.34, 0.0, 0.34)[voice_index]
            pad_left += tone * amp * (1.0 - pan * 0.45)
            pad_right += tone * amp * (1.0 + pan * 0.45)

        beat_t = t % 2.0
        kick_env = math.exp(-beat_t * 10.0)
        kick_phase = 2.0 * math.pi * (54.0 + 38.0 * math.exp(-beat_t * 22.0)) * beat_t
        kick = math.sin(kick_phase) * 0.055 * kick_env

        pulse_t = t % 1.0
        pulse_note = chord[(int(t) + chord_index) % 3] + 12
        pulse_env = math.exp(-pulse_t * 5.2)
        pulse = math.sin(2.0 * math.pi * note_frequency(pulse_note) * pulse_t) * 0.026 * pulse_env

        hat_position = (t + 0.5) % 1.0
        hat_env = math.exp(-hat_position * 34.0)
        hat = (rng.random() * 2.0 - 1.0) * 0.010 * hat_env

        intro = smoothstep(t / 2.2)
        outro = smoothstep((duration - t) / 3.0)
        envelope = intro * outro
        left = (pad_left + kick + pulse * 0.8 + hat) * master * envelope
        right = (pad_right + kick + pulse + hat * 0.75) * master * envelope
        samples.append(max(-32767, min(32767, int(left * 32767))))
        samples.append(max(-32767, min(32767, int(right * 32767))))

    target = OUTPUT / "ambient-bed.wav"
    with wave.open(str(target), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(samples.tobytes())
    print(f"MUSIC: {target} ({target.stat().st_size} bytes)")
    return target


def main() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    data = json.loads(SCRIPT.read_text(encoding="utf-8"))
    asyncio.run(generate_voiceovers(data))
    generate_music(float(data["durationSeconds"]))


if __name__ == "__main__":
    main()

