import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(description="Local Whisper transcription")
    parser.add_argument("--input", required=True, help="Path to audio file")
    parser.add_argument("--model", default="tiny", help="Whisper model name (tiny, base, small, medium, large)")
    parser.add_argument("--language", default="", help="Optional language code, e.g. en")
    parser.add_argument("--task", default="transcribe", choices=["transcribe", "translate"], help="Whisper task")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Input file not found: {args.input}", file=sys.stderr)
        sys.exit(1)

    try:
        import whisper  # type: ignore
    except Exception:
        print("Missing dependency: openai-whisper. Install with: pip install -U openai-whisper", file=sys.stderr)
        sys.exit(1)

    model = whisper.load_model(args.model)
    options = {
        "task": args.task,
        "fp16": False
    }
    if args.language:
        options["language"] = args.language

    try:
        result = model.transcribe(args.input, **options)
        text = (result.get("text") or "").strip()
        print(text)
    except Exception as exc:
        print(f"Whisper failed: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
