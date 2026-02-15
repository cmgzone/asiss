# Local Whisper (Tiny) STT

This project supports **local Whisper** transcription (tiny model) in addition to Deepgram.

## Setup
1. Install Python 3.9+ and `ffmpeg`.
2. Install Whisper:
   - `pip install -U openai-whisper`
3. Set env vars (see `.env.example`):
```
STT_PROVIDER=whisper
WHISPER_PYTHON=python
WHISPER_SCRIPT=scripts/whisper_transcribe.py
WHISPER_MODEL=tiny
WHISPER_LANGUAGE=
```

## How It Works
- Audio uploads from the Web UI are written to `artifacts/stt/`.
- The server runs `scripts/whisper_transcribe.py` and reads the transcript from stdout.
- If Whisper fails, the request returns an error.

## Notes
- `WHISPER_LANGUAGE` is optional (e.g. `en`). Leave empty for auto-detect.
- `WHISPER_TIMEOUT_MS` controls the max transcription time.
