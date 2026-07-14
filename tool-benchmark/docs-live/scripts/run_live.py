#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[3]
BENCHMARK = ROOT / "tool-benchmark/docs-live"


def model_arg(value: str) -> tuple[str, str]:
    label, separator, model = value.partition("=")
    if not separator or not label or not model:
        raise argparse.ArgumentTypeError("--model must use LABEL=MODEL")
    return label, model


def run(command: list[str]) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(command, cwd=ROOT, check=True)


def write_matrix(rows: list[dict[str, Any]], output_dir: Path) -> None:
    json_path = output_dir / "matrix-summary.json"
    csv_path = output_dir / "matrix-summary.csv"
    delta_path = output_dir / "paired-deltas.csv"
    pairs: dict[tuple[str, int], dict[str, dict[str, Any]]] = {}
    for row in rows:
        pairs.setdefault((row["model_label"], row["repetition"]), {})[row["variant"]] = row
    deltas = []
    for (model_label, repetition), variants in pairs.items():
        if "docs" not in variants or "files" not in variants:
            continue
        docs = variants["docs"]
        files = variants["files"]
        numeric = [
            key for key, value in docs.items()
            if (key.startswith("mean_") or key.endswith("_rate")) and isinstance(value, (int, float))
        ]
        deltas.append({
            "model_label": model_label,
            "model": docs["model"],
            "repetition": repetition,
            **{f"files_minus_docs:{key}": files[key] - docs[key] for key in numeric},
        })
    json_path.write_text(json.dumps({"runs": rows, "paired_deltas": deltas}, indent=2) + "\n", encoding="utf-8")
    fieldnames: list[str] = []
    for row in rows:
        fieldnames.extend(key for key in row if key not in fieldnames)
    with csv_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)
    delta_fields: list[str] = []
    for row in deltas:
        delta_fields.extend(key for key in row if key not in delta_fields)
    with delta_path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=delta_fields)
        if delta_fields:
            writer.writeheader()
            writer.writerows(deltas)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", action="append", type=model_arg, required=True)
    parser.add_argument("--runs", type=int, default=1)
    parser.add_argument("--parallel", type=int, default=1)
    parser.add_argument("--limit", type=int)
    parser.add_argument("--input", type=Path, default=BENCHMARK / "data/prompts.dual.jsonl")
    parser.add_argument("--output-dir", type=Path, default=BENCHMARK / "runs/live")
    args = parser.parse_args()

    if args.parallel != 1:
        raise SystemExit("--parallel must be 1 because fast-agent cannot combine parallel batches with trace export")
    if not args.input.exists():
        raise SystemExit(f"missing prompt set: {args.input}; generate it as described in {BENCHMARK / 'README.md'}")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    input_hash = hashlib.sha256(args.input.read_bytes()).hexdigest()
    matrix = []

    for model_label, model in args.model:
        for repetition in range(1, args.runs + 1):
            for variant in ("docs", "files"):
                name = f"{model_label}-{variant}-run-{repetition}"
                output = args.output_dir / f"{name}.jsonl"
                telemetry = args.output_dir / f"{name}.telemetry.jsonl"
                summary = args.output_dir / f"{name}.batch-summary.json"
                traces = args.output_dir / f"{name}.traces"
                report = args.output_dir / f"{name}.score.json"
                command = [
                    "fast-agent", "batch", "run",
                    "--input", str(args.input),
                    "--output", str(output),
                    "--template", str(BENCHMARK / "prompts/answer.md"),
                    "--agent-card", str(BENCHMARK / f"agent-cards/{variant}.md"),
                    "--model", model,
                    "--id-field", "id",
                    "--include-input",
                    "--parallel", str(args.parallel),
                    "--overwrite",
                    "--telemetry-output", str(telemetry),
                    "--summary-output", str(summary),
                    "--export-traces", str(traces),
                ]
                if args.limit is not None:
                    command.extend(["--limit", str(args.limit)])
                run(command)
                run([
                    "python", str(BENCHMARK / "scripts/score_live.py"),
                    "--output", str(output),
                    "--telemetry", str(telemetry),
                    "--traces", str(traces),
                    "--variant", variant,
                    "--model", model,
                    "--repetition", str(repetition),
                    "--report", str(report),
                ])
                scored = json.loads(report.read_text())
                matrix.append({
                    "model_label": model_label,
                    "model": model,
                    "variant": variant,
                    "repetition": repetition,
                    "input_sha256": input_hash,
                    "report": str(report),
                    **{key: value for key, value in scored.items() if key.startswith("mean_") or key.endswith("_rate")},
                })
                write_matrix(matrix, args.output_dir)

    print(f"wrote {args.output_dir / 'matrix-summary.json'} and {args.output_dir / 'matrix-summary.csv'}")


if __name__ == "__main__":
    main()
