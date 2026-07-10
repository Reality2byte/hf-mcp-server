#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-.env.test}"
BASE_URL="${HF_FS_LIVE_BASE_URL:-http://localhost:3000}"
MCP_URL="$BASE_URL/mcp"
TMP="$(mktemp -d)"
SERVER_PID=""

cleanup() {
	if [[ -n "$SERVER_PID" ]]; then
		kill -TERM -- "-$SERVER_PID" 2>/dev/null || true
	fi
	rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

for command in curl jq; do
	command -v "$command" >/dev/null || {
		echo "Missing required command: $command" >&2
		exit 1
	}
done

if ! curl -fsS --max-time 2 "$BASE_URL/api/transport" >/dev/null 2>&1; then
	echo "Starting test server..."
	cd "$ROOT"
	setsid ./start-test-server.sh "$ENV_FILE" >"$TMP/server.log" 2>&1 &
	SERVER_PID=$!

	for _ in $(seq 1 120); do
		curl -fsS --max-time 2 "$BASE_URL/api/transport" >/dev/null 2>&1 && break
		kill -0 "$SERVER_PID" 2>/dev/null || {
			cat "$TMP/server.log" >&2
			exit 1
		}
		sleep 1
	done
	curl -fsS --max-time 2 "$BASE_URL/api/transport" >/dev/null || {
		cat "$TMP/server.log" >&2
		exit 1
	}
else
	echo "Using existing server at $BASE_URL"
fi

curl -fsS --max-time 60 -D "$TMP/init.headers" \
	-H 'Content-Type: application/json' \
	-H 'Accept: application/json, text/event-stream' \
	--data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"hf-fs-live","version":"1.0.0"}}}' \
	"$MCP_URL" >"$TMP/init.json"

SESSION="$(awk 'BEGIN { IGNORECASE=1 } /^Mcp-Session-Id:/ { gsub("\r", ""); print $2 }' "$TMP/init.headers")"
[[ -n "$SESSION" ]] || {
	echo "Server did not return Mcp-Session-Id" >&2
	exit 1
}

ID=1
call_hf_fs() {
	local name=$1
	local args=$2
	ID=$((ID + 1))
	jq -nc --argjson id "$ID" --argjson args "$args" \
		'{jsonrpc:"2.0",id:$id,method:"tools/call",params:{name:"hf_fs",arguments:$args}}' >"$TMP/request.json"
	curl -fsS --max-time 60 \
		-H 'Content-Type: application/json' \
		-H 'Accept: application/json, text/event-stream' \
		-H "Mcp-Session-Id: $SESSION" \
		--data-binary @"$TMP/request.json" \
		"$MCP_URL" >"$TMP/$name.json"
	jq -e '.result.isError != true and .result.structuredContent != null' "$TMP/$name.json" >/dev/null || {
		jq . "$TMP/$name.json" >&2
		exit 1
	}
}

pass() {
	echo "✓ $1"
}

call_hf_fs root '{"op":"ls","uri":"hf://"}'
jq -e '.result.structuredContent.entries | map(.path) | (index("README.md") != null and index("papers") != null)' \
	"$TMP/root.json" >/dev/null
pass 'root lists README.md and papers'

call_hf_fs papers '{"op":"ls","uri":"hf://papers","limit":10}'
jq -e '.result.structuredContent as $r | ($r.entries[0:3] | map(.path)) == ["README.md","daily","trending"] and ($r.entries[0].description | contains("hf://papers/2502.16161/paper.md")) and ($r.entries[3:] | length == 10 and all(.[]; .type == "paper" and (.uri | startswith("hf://papers/")))) and $r.truncated == true and $r.truncation_reason == "provider_limit"' \
	"$TMP/papers.json" >/dev/null
pass 'Papers root lists bounded views and 10 recent canonical paper samples'

call_hf_fs daily_root '{"op":"ls","uri":"hf://papers/daily","limit":10}'
jq -e '.result.structuredContent.entries[0] | .path == "latest" and .uri == "hf://papers/daily/latest" and (.target_uri | startswith("hf://papers/daily/")) and .daily_papers_date != null' \
	"$TMP/daily_root.json" >/dev/null
pass 'Daily Papers root exposes the latest alias'

call_hf_fs daily_latest '{"op":"ls","uri":"hf://papers/daily/latest","limit":3}'
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .type == "paper" and .daily_papers_date != null and (.daily_papers_uri | startswith("hf://papers/daily/")))' \
	"$TMP/daily_latest.json" >/dev/null
PAPER_URI="$(jq -r '.result.structuredContent.entries[0].uri' "$TMP/daily_latest.json")"
pass 'daily/latest resolves a dated Daily Papers batch'

call_hf_fs trending '{"op":"ls","uri":"hf://papers/trending","recursive":true,"limit":3}'
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .type == "paper" and .observed_at != null)' \
	"$TMP/trending.json" >/dev/null
pass 'trending is a bounded index and recursive ls does not follow paper edges'

call_hf_fs paper_stat "$(jq -nc --arg uri "$PAPER_URI" '{op:"stat",uri:$uri}')"
jq -e '.result.structuredContent | .exists == true and .type == "paper" and .url != null and .arxiv_url != null' \
	"$TMP/paper_stat.json" >/dev/null
pass 'Daily Paper stat resolves canonical web metadata'

REPO='hf://models/openai/gpt-oss-20b'
call_hf_fs find_json "$(jq -nc --arg uri "$REPO" \
	'{op:"find",uri:$uri,entry_type:"file",name:"*.json",path:"**/*.json",limit:5}')"
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .type == "file" and (.path | endswith(".json")))' \
	"$TMP/find_json.json" >/dev/null
pass 'recursive find works with expand=false'

call_hf_fs find_exact "$(jq -nc --arg uri "$REPO/config.json" \
	'{op:"find",uri:$uri,entry_type:"file",name:"config.json",path:"config.json"}')"
jq -e '.result.structuredContent.entries | length == 1 and .[0].path == "config.json"' \
	"$TMP/find_exact.json" >/dev/null
pass 'exact-file find uses stat behavior'

call_hf_fs find_nested "$(jq -nc --arg uri "$REPO/original" \
	'{op:"find",uri:$uri,entry_type:"file",name:"*.json",path:"*.json",limit:10}')"
jq -e '.result.structuredContent.entries | length > 0 and all(.[]; .path | startswith("original/"))' \
	"$TMP/find_nested.json" >/dev/null
pass 'nested find filters relative paths and emits repo-root paths'

echo "hf_fs live smoke tests passed"
