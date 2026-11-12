"""Word-level transcription for Premiere Pro MCP Plus (faster-whisper, local).

Usage: python transcribe.py <file> [--model base] [--language pt] [--start S] [--duration D]
Prints one JSON object: {language, duration, segments:[{start,end,text}], words:[{start,end,word,p}]}
"""
import argparse
import json
import subprocess
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file")
    ap.add_argument("--model", default="base")
    ap.add_argument("--language", default=None)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--duration", type=float, default=0.0)
    a = ap.parse_args()

    from faster_whisper import WhisperModel

    import numpy as np

    # Decode with FFmpeg (16 kHz mono float) instead of PyAV: avoids PyAV version issues.
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    if a.start:
        cmd += ["-ss", str(a.start)]
    if a.duration:
        cmd += ["-t", str(a.duration)]
    cmd += ["-i", a.file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "-"]
    pcm = subprocess.run(cmd, check=True, capture_output=True).stdout
    audio = np.frombuffer(pcm, dtype=np.float32)
    import os
    # CPU by default: "auto" picks CUDA when a GPU exists, even without the cuBLAS DLLs.
    model = WhisperModel(a.model, device=os.environ.get("PREMIERE_MCP_WHISPER_DEVICE", "cpu"), compute_type="int8")
    segments, info = model.transcribe(audio, language=a.language, word_timestamps=True, vad_filter=False, condition_on_previous_text=False)
    out = {"language": info.language, "duration": info.duration, "segments": [], "words": []}
    for s in segments:
        out["segments"].append({"start": round(s.start + a.start, 3), "end": round(s.end + a.start, 3), "text": s.text.strip()})
        for w in s.words or []:
            out["words"].append({"start": round(w.start + a.start, 3), "end": round(w.end + a.start, 3), "word": w.word.strip(), "p": round(w.probability, 3)})
    sys.stdout.write(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
