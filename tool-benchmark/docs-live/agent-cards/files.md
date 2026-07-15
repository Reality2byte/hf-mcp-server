---
type: agent
name: files_live
model: "$system.default"
skills: []
use_history: false
mcp_connect:
  - name: hf_files_live
    target: http://localhost:3000/mcp?bouquet=files
request_params:
  max_iterations: 12
  parallel_tool_calls: false
---

Answer the user's request using the available Hugging Face tools.
Use tool results as evidence, continue until you have enough information, and
give a concise final answer. Do not discuss tool selection or internal steps.
