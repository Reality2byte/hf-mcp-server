---
type: agent
name: spaces_files_live
model: "$system.default"
skills: []
use_history: false
mcp_connect:
  - name: hf_spaces_files
    target: http://localhost:3000/mcp?bouquet=files
request_params:
  max_iterations: 12
  parallel_tool_calls: false
---

Answer the user's request using the available Hugging Face tools.
Recommend at most three strongly relevant Spaces with links and briefly explain
why each matches. If the user asks for MCP-enabled Spaces, recommend only
MCP-enabled results supported by tool evidence. Do not invent results or discuss
tool selection.
