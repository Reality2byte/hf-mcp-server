#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import statistics
from pathlib import Path
from typing import Any

from common import read_jsonl


TOKEN_FIELDS = ("input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens")


def trace_metrics(path: Path) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        "turns": 0,
        "tool_calls": 0,
        "tool_errors": 0,
        "final_answer": False,
        "tool_names": [],
        **{field: 0 for field in TOKEN_FIELDS},
    }
    last_response_type: tuple[Any, Any] | None = None
    for record in read_jsonl(path):
        payload = record.get("payload")
        if not isinstance(payload, dict):
            continue
        if record.get("type") == "event_msg" and payload.get("type") == "token_count":
            usage = payload.get("info", {}).get("last_token_usage", {})
            if isinstance(usage, dict):
                metrics["turns"] += 1
                for field in TOKEN_FIELDS:
                    value = usage.get(field)
                    if isinstance(value, int):
                        metrics[field] += value
        if record.get("type") != "response_item":
            continue
        last_response_type = payload.get("type"), payload.get("role")
        if payload.get("type") == "function_call":
            metrics["tool_calls"] += 1
            name = payload.get("name")
            if isinstance(name, str):
                metrics["tool_names"].append(name)
        elif payload.get("type") == "function_call_output" and payload.get("status") == "error":
            metrics["tool_errors"] += 1
    metrics["final_answer"] = last_response_type == ("message", "assistant")
    return metrics


def has_nonempty_result(envelope: dict[str, Any]) -> bool:
    result = envelope.get("result")
    if isinstance(result, str):
        return bool(result.strip())
    return result is not None


def mean(rows: list[dict[str, Any]], key: str) -> float:
    values = [float(row[key]) for row in rows]
    return statistics.fmean(values) if values else 0.0


def score(
    output: Path,
    telemetry: Path,
    traces: Path,
    variant: str,
    model: str,
    repetition: int,
) -> dict[str, Any]:
    outputs = {str(row["id"]): row for row in read_jsonl(output)}
    timing = {
        str(row["id"]): row.get("timing", {})
        for row in read_jsonl(telemetry)
    }
    manifest = list(read_jsonl(traces / "manifest.jsonl"))
    rows = []
    for item in manifest:
        identity = str(item["id"])
        envelope = outputs.get(identity, {})
        source = envelope.get("input", {})
        trace = item.get("trace")
        metrics = trace_metrics(traces / trace) if isinstance(trace, str) else {
            "turns": 0,
            "tool_calls": 0,
            "tool_errors": 0,
            "final_answer": False,
            "tool_names": [],
            **{field: 0 for field in TOKEN_FIELDS},
        }
        batch_ok = item.get("ok") is True and envelope.get("ok") is True
        completed = batch_ok and metrics["tool_calls"] > 0 and metrics["final_answer"] and has_nonempty_result(envelope)
        error_free = metrics["tool_errors"] == 0
        rows.append({
            "id": identity,
            "semantic_id": source.get("semantic_id") if isinstance(source, dict) else None,
            "prompt_family": source.get("prompt_family") if isinstance(source, dict) else None,
            "variant": variant,
            "model": model,
            "repetition": repetition,
            "batch_ok": batch_ok,
            "completed": completed,
            "error_free": error_free,
            "recovered_tool_error": completed and not error_free,
            "duration_ms": timing.get(identity, {}).get("duration_ms", 0),
            **metrics,
        })

    summary = {
        "variant": variant,
        "model": model,
        "repetition": repetition,
        "rows": len(rows),
        "batch_ok_rate": mean(rows, "batch_ok"),
        "completion_rate": mean(rows, "completed"),
        "error_free_rate": mean(rows, "error_free"),
        "recovered_tool_error_rate": mean(rows, "recovered_tool_error"),
        **{f"mean_{key}": mean(rows, key) for key in ("duration_ms", "turns", "tool_calls", *TOKEN_FIELDS)},
        "row_metrics": rows,
    }
    return summary


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "id", "semantic_id", "prompt_family", "variant", "model", "repetition",
        "batch_ok", "completed", "error_free", "recovered_tool_error",
        "final_answer", "duration_ms", "turns", "tool_calls", "tool_errors",
        *TOKEN_FIELDS, "tool_names",
    ]
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            writer.writerow({**row, "tool_names": ",".join(row["tool_names"])})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--telemetry", type=Path, required=True)
    parser.add_argument("--traces", type=Path, required=True)
    parser.add_argument("--variant", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--repetition", type=int, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()

    report = score(args.output, args.telemetry, args.traces, args.variant, args.model, args.repetition)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    write_csv(args.report.with_suffix(".csv"), report["row_metrics"])
    print(f"wrote {args.report} and {args.report.with_suffix('.csv')}")


if __name__ == "__main__":
    main()
