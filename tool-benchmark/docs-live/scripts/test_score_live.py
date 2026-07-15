from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from score_live import score


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


class ScoreLiveTest(unittest.TestCase):
    def test_scores_row_local_turns_tokens_and_tool_errors(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root / "output.jsonl"
            telemetry = root / "telemetry.jsonl"
            traces = root / "traces"
            write_jsonl(output, [{
                "id": "case",
                "ok": True,
                "result": "answer",
                "input": {"semantic_id": "semantic", "prompt_family": "openai"},
            }])
            write_jsonl(telemetry, [{
                "id": "case",
                "timing": {"duration_ms": 1234},
            }])
            write_jsonl(traces / "manifest.jsonl", [{
                "id": "case", "ok": True, "trace": "case.jsonl",
            }])
            write_jsonl(traces / "case.jsonl", [
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {"last_token_usage": {
                            "input_tokens": 100,
                            "output_tokens": 20,
                            "total_tokens": 120,
                        }},
                    },
                },
                {
                    "type": "response_item",
                    "payload": {"type": "function_call", "name": "hf_fs"},
                },
                {
                    "type": "response_item",
                    "payload": {"type": "function_call_output", "status": "success"},
                },
                {
                    "type": "event_msg",
                    "payload": {
                        "type": "token_count",
                        "info": {"last_token_usage": {
                            "input_tokens": 250,
                            "output_tokens": 30,
                            "total_tokens": 280,
                        }},
                    },
                },
                {
                    "type": "response_item",
                    "payload": {"type": "message", "role": "assistant"},
                },
            ])

            report = score(output, telemetry, traces, "files", "model", 1)

            self.assertEqual(1, report["rows"])
            self.assertEqual(1.0, report["completion_rate"])
            self.assertEqual(2.0, report["mean_turns"])
            self.assertEqual(1.0, report["mean_tool_calls"])
            self.assertEqual(350.0, report["mean_input_tokens"])
            self.assertEqual(400.0, report["mean_total_tokens"])
            self.assertEqual(1234.0, report["mean_duration_ms"])
            self.assertEqual("openai", report["row_metrics"][0]["prompt_family"])


if __name__ == "__main__":
    unittest.main()
