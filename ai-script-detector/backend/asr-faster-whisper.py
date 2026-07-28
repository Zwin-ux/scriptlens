#!/usr/bin/env python3
import argparse
import json
import os
import sys


def parse_args():
  parser = argparse.ArgumentParser(
    description="Run faster-whisper on a downloaded audio file and emit ScriptLens JSON."
  )
  parser.add_argument("--audio-path", required=True)
  parser.add_argument("--output-path", default="")
  parser.add_argument("--requested-language-code", default="")
  parser.add_argument("--trace-id", default="")
  parser.add_argument("--video-id", default="")
  return parser.parse_args()


def parse_bool_env(name, fallback):
  value = str(os.getenv(name, "")).strip().lower()
  if value in ("true", "1", "yes", "on"):
    return True
  if value in ("false", "0", "no", "off"):
    return False
  return fallback


def parse_int_env(name, fallback):
  value = str(os.getenv(name, "")).strip()
  if not value:
    return fallback
  try:
    return int(value)
  except ValueError:
    return fallback


def normalize_language(value):
  text = str(value or "").strip().lower()
  return text or None


def normalize_text(value):
  return " ".join(str(value or "").split()).strip()


def build_model_kwargs():
  kwargs = {
    "device": str(os.getenv("SCRIPTLENS_BACKEND_ASR_DEVICE", "cpu")).strip() or "cpu",
    "compute_type": str(os.getenv("SCRIPTLENS_BACKEND_ASR_COMPUTE_TYPE", "int8")).strip() or "int8",
  }
  cpu_threads = parse_int_env("SCRIPTLENS_BACKEND_ASR_CPU_THREADS", 0)
  if cpu_threads > 0:
    kwargs["cpu_threads"] = cpu_threads
  return kwargs


def main():
  args = parse_args()
  try:
    from faster_whisper import WhisperModel
  except Exception as error:
    sys.stderr.write(f"faster-whisper import failed: {error}\n")
    return 1

  model_name = str(os.getenv("SCRIPTLENS_BACKEND_ASR_MODEL", "tiny.en")).strip() or "tiny.en"
  beam_size = max(1, parse_int_env("SCRIPTLENS_BACKEND_ASR_BEAM_SIZE", 1))
  vad_filter = parse_bool_env("SCRIPTLENS_BACKEND_ASR_VAD_FILTER", True)
  requested_language = normalize_language(args.requested_language_code)

  try:
    model = WhisperModel(model_name, **build_model_kwargs())
    segments_iter, info = model.transcribe(
      args.audio_path,
      language=requested_language,
      beam_size=beam_size,
      vad_filter=vad_filter,
      condition_on_previous_text=False,
      word_timestamps=False,
    )
  except Exception as error:
    sys.stderr.write(f"faster-whisper transcription failed: {error}\n")
    return 1

  segments = []
  text_parts = []
  for segment in segments_iter:
    text = normalize_text(getattr(segment, "text", ""))
    if not text:
      continue
    start_seconds = float(getattr(segment, "start", 0.0) or 0.0)
    end_seconds = float(getattr(segment, "end", start_seconds) or start_seconds)
    duration_ms = max(0, round((end_seconds - start_seconds) * 1000))
    segments.append(
      {
        "startMs": round(start_seconds * 1000),
        "durationMs": duration_ms,
        "text": text,
      }
    )
    text_parts.append(text)

  payload = {
    "ok": True,
    "text": "\n".join(text_parts).strip(),
    "segments": segments,
    "languageCode": normalize_language(getattr(info, "language", None)) or requested_language,
    "originalLanguageCode": normalize_language(getattr(info, "language", None)) or requested_language,
    "sourceConfidence": "low",
    "warnings": ["audio_asr_faster_whisper"],
    "detail": {
      "engine": "faster-whisper",
      "model": model_name,
      "beamSize": beam_size,
      "vadFilter": vad_filter,
      "device": str(os.getenv("SCRIPTLENS_BACKEND_ASR_DEVICE", "cpu")).strip() or "cpu",
      "computeType": str(os.getenv("SCRIPTLENS_BACKEND_ASR_COMPUTE_TYPE", "int8")).strip() or "int8",
      "languageProbability": getattr(info, "language_probability", None),
      "traceId": args.trace_id or None,
      "videoId": args.video_id or None,
    },
  }

  if args.output_path:
    with open(args.output_path, "w", encoding="utf-8") as handle:
      json.dump(payload, handle, ensure_ascii=True)
  sys.stdout.write(json.dumps(payload, ensure_ascii=True))
  return 0


if __name__ == "__main__":
  raise SystemExit(main())
