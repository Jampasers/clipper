#!/usr/bin/env python
"""Transcribe an audio file with faster-whisper. Emits JSON lines on stdout:
  {"type":"progress","done":<sec>,"duration":<sec>}
  {"type":"done","segments":[{start,end,text,words?}],"language":...,"duration":...}
Errors go to stderr, exit code 1.
"""
import argparse
import json
import os
import sys
import tempfile


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="base")
    ap.add_argument("--language", default="")
    ap.add_argument("--word-timestamps", default="1")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        print(f"IMPORT_ERROR: faster-whisper unavailable: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        emit({"type": "load_start"})
        # Leave one core free so the app stays responsive while transcribing.
        cpu_threads = max(1, (os.cpu_count() or 2) - 1)
        model = WhisperModel(
            args.model,
            device=os.environ.get("WHISPER_DEVICE", "cpu"),
            compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
            cpu_threads=cpu_threads,
        )
        emit({"type": "load_done"})
        segments_iter, info = model.transcribe(
            args.audio,
            language=args.language or None,
            word_timestamps=args.word_timestamps == "1",
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=400),
            beam_size=1,  # greedy: ~4x faster than beam=5 on CPU, avoids pathological alignment hangs
        )
        duration = info.duration or 0
        segments = []
        for seg in segments_iter:
            words = []
            if args.word_timestamps == "1" and getattr(seg, "words", None):
                for w in seg.words:
                    words.append({"start": round(w.start, 3), "end": round(w.end, 3), "word": w.word})
            segments.append(
                {
                    "start": round(seg.start, 3),
                    "end": round(seg.end, 3),
                    "text": seg.text.strip(),
                    "words": words,
                }
            )
            emit({"type": "progress", "done": seg.end, "duration": duration})
        emit(
            {
                "type": "done",
                "segments": segments,
                "language": info.language,
                "duration": duration,
            }
        )
    except Exception as e:
        print(f"TRANSCRIBE_ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
