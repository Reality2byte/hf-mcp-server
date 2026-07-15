#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

from common import read_jsonl, write_jsonl


def family_arg(value: str) -> tuple[str, Path]:
    name, separator, path = value.partition("=")
    if not separator or not name or not path:
        raise argparse.ArgumentTypeError("--family must use NAME=PATH")
    return name, Path(path)


def load_results(path: Path) -> dict[str, dict[str, Any]]:
    results = {}
    for envelope in read_jsonl(path):
        if envelope.get("ok") is True and isinstance(envelope.get("result"), dict):
            results[str(envelope["id"])] = envelope["result"]
    return results


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--calls", type=Path, required=True)
    parser.add_argument("--family", action="append", type=family_arg, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    calls = list(read_jsonl(args.calls))
    rows = []
    for family, path in args.family:
        prompts = load_results(path)
        for call in calls:
            case_id = str(call["id"])
            generated = prompts.get(case_id)
            if generated is None:
                raise SystemExit(f"missing successful prompt for {case_id} from {family}")
            rows.append({
                **call,
                "id": f"{case_id}::{family}",
                "semantic_id": case_id,
                "prompt_family": family,
                "prompt": generated["prompt"],
                "prompt_confidence": generated["confidence"],
                "prompt_note": generated["label_note"],
            })

    write_jsonl(args.output, rows)
    print(f"wrote {len(rows)} prompt variants for {len(calls)} semantic cases")


if __name__ == "__main__":
    main()
