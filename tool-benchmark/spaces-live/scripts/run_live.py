#!/usr/bin/env python3
from __future__ import annotations

import argparse
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
BENCHMARK = ROOT / "tool-benchmark/spaces-live"
SCORER = ROOT / "tool-benchmark/docs-live/scripts/score_live.py"


def model_arg(value: str) -> tuple[str, str]:
	label, separator, model = value.partition("=")
	if not separator or not label or not model:
		raise argparse.ArgumentTypeError("--model must use LABEL=MODEL")
	return label, model


def run(command: list[str]) -> None:
	print("+", " ".join(command), flush=True)
	subprocess.run(command, cwd=ROOT, check=True)


def main() -> None:
	parser = argparse.ArgumentParser()
	parser.add_argument("--model", action="append", type=model_arg, required=True)
	parser.add_argument("--runs", type=int, default=1)
	parser.add_argument("--limit", type=int)
	parser.add_argument("--output-dir", type=Path, default=BENCHMARK / "runs/live")
	args = parser.parse_args()
	args.output_dir.mkdir(parents=True, exist_ok=True)

	for label, model in args.model:
		for repetition in range(1, args.runs + 1):
			for variant in ("legacy", "files"):
				name = f"{label}-{variant}-run-{repetition}"
				output = args.output_dir / f"{name}.jsonl"
				telemetry = args.output_dir / f"{name}.telemetry.jsonl"
				traces = args.output_dir / f"{name}.traces"
				summary = args.output_dir / f"{name}.batch-summary.json"
				report = args.output_dir / f"{name}.score.json"
				command = [
					"fast-agent",
					"batch",
					"run",
					"--input",
					str(BENCHMARK / "data/prompts.dual.jsonl"),
					"--output",
					str(output),
					"--template",
					str(BENCHMARK / "prompts/answer.md"),
					"--agent-card",
					str(BENCHMARK / f"agent-cards/{variant}.md"),
					"--model",
					model,
					"--id-field",
					"id",
					"--include-input",
					"--parallel",
					"1",
					"--overwrite",
					"--telemetry-output",
					str(telemetry),
					"--summary-output",
					str(summary),
					"--export-traces",
					str(traces),
				]
				if args.limit is not None:
					command.extend(["--limit", str(args.limit)])
				run(command)
				run(
					[
						"python",
						str(SCORER),
						"--output",
						str(output),
						"--telemetry",
						str(telemetry),
						"--traces",
						str(traces),
						"--variant",
						variant,
						"--model",
						model,
						"--repetition",
						str(repetition),
						"--report",
						str(report),
					]
				)


if __name__ == "__main__":
	main()
