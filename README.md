# Hugging Face Official MCP Server 

<img src='hf-logo.svg' width='100'>

Welcome to the official Hugging Face MCP Server 🤗. Connect your LLM to the Hugging Face Hub and thousands of Gradio AI Applications.


## Installing the MCP Server

Follow the instructions below to get started:

<details>
<summary>Install in <b>Claude Desktop</b> or <b>claude.ai</b></summary>
<br />

Click [here](https://claude.ai/redirect/website.v1.67274164-23df-4883-8166-3c93ced276be/directory/37ed56d5-9d61-4fd4-ad00-b9134c694296) to add the Hugging Face connector to your account. 

Alternatively, navigate to [https://claude.ai/settings/connectors](https://claude.ai/settings/connectors), and add "Hugging Face" from the gallery.

<img src='docs/claude-badge.png' width='50%' align='center' />

</details>

<details>
<summary>Install in <b>Claude Code</b></summary>
<br />

Enter the command below to install in <b>Claude Code</b>:

```bash
claude mcp add hf-mcp-server -t http https://huggingface.co/mcp?login
```

Then start `claude` and follow the instructions to complete authentication.

```bash
claude mcp add hf-mcp-server \
  -t http https://huggingface.co/mcp \
  -H "Authorization: Bearer <YOUR_HF_TOKEN>"
```


</details>

<details>

<summary>Install in <b>VSCode</b></summary>
<br />

Click <a href="vscode:mcp/install?%7B%22name%22%3A%22huggingface%22%2C%22gallery%22%3Atrue%2C%22url%22%3A%22https%3A%2F%2Fhuggingface.co%2Fmcp%3Flogin%22%7D">here</a> to add the Hugging Face connector directly to VSCode. Alternatively, install from the gallery at [https://code.visualstudio.com/mcp](https://code.visualstudio.com/mcp): 

<img src='docs/vscode-badge.png' width='50%' align='center' />

If you prefer to configure manually or use an auth token, add the snippet below to your `mcp.json` configuration:


```JSON
"huggingface": {
    "url": "https://huggingface.co/mcp",
    "headers": {
        "Authorization": "Bearer <YOUR_HF_TOKEN>"
    }
```

</details>

<details>
<summary>Install in <b>Cursor</b></summary>
<br />

Click <a href="https://cursor.com/en/install-mcp?name=Hugging%20Face&config=eyJ1cmwiOiJodHRwczovL2h1Z2dpbmdmYWNlLmNvL21jcD9sb2dpbiJ9">here</a> to install the Hugging Face MCP Server directly in <b>Cursor</b>. 

If you prefer to use configure manually or specify an Authorization Token, use the snippet below:

```JSON
"huggingface": {
    "url": "https://huggingface.co/mcp",
    "headers": {
        "Authorization": "Bearer <YOUR_HF_TOKEN>"
    }
```
</details>

Once installed, navigate to https://huggingface.co/settings/mcp to configure your Tools and Spaces.

![hf_mcp_server_small](https://github.com/user-attachments/assets/d30f9f56-b08c-4dfc-a68f-a164a93db564)


## Quick Guide (Repository Packages)

This repo contains:

 - (`/mcp`) MCP Implementations of Hub API and Search endpoints for integration with MCP Servers. 
 - (`/app`) An MCP Server and Web Application for deploying endpoints.

### MCP Server

The following transports are supported:

- STDIO 
- SSE (To be deprecated, but still commonly deployed).
- StreamableHTTP
- StreamableHTTP in Stateless JSON Mode (**StreamableHTTPJson**)

The Web Application and HTTP Transports start by default on Port 3000. 

SSE and StreamableHTTP services are available at `/sse` and `/mcp` respectively. Although though not strictly enforced by the specification this is common convention.

> [!TIP]
> The Web Application allows you to switch tools on and off. For STDIO, SSE and StreamableHTTP this will send a ToolListChangedNotification to the MCP Client. In StreamableHTTPJSON mode the tool will not be listed when the client next requests the tool lists.

### Running Locally

You can run the MCP Server locally with either `npx` or `docker`. 

```bash
npx @llmindset/hf-mcp-server       # Start in STDIO mode
npx @llmindset/hf-mcp-server-http  # Start in Streamable HTTP mode
npx @llmindset/hf-mcp-server-json  # Start in Streamable HTTP (JSON RPC) mode
```

To run with docker: 

```bash
docker pull ghcr.io/evalstate/hf-mcp-server:latest
docker run --rm -p 3000:3000 ghcr.io/evalstate/hf-mcp-server:latest
```
![image](https://github.com/user-attachments/assets/2fc0ef58-2c7a-4fae-82b5-e6442bfcbd99)

All commands above start the Management Web interface on http://localhost:3000/. The Streamable HTTP server is accessible on  http://localhost:3000/mcp. See [Environment Variables](#Environment Variables) for configuration options. Docker defaults to Streamable HTTP (JSON RPC) mode.


## Development

This project uses `pnpm` for build and development. Corepack is used to ensure everyone uses the same pnpm version (10.12.3).

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Build Commands

`pnpm run clean` -> clean build artifacts

`pnpm run build` -> build packages

`pnpm run start` -> start the mcp server application

`pnpm run buildrun` -> clean, build and start

`pnpm run dev` -> concurrently watch `mcp` and start dev server with HMR


## Docker Build

Build the image:
```bash
docker build -t hf-mcp-server .
```

Run with default settings (Streaming HTTP JSON Mode), Dashboard on Port 3000:
```bash
docker run --rm -p 3000:3000 -e DEFAULT_HF_TOKEN=hf_xxx hf-mcp-server
```

Run STDIO MCP Server:
```bash
docker run -i --rm -e TRANSPORT=stdio -p 3000:3000 -e DEFAULT_HF_TOKEN=hf_xxx hf-mcp-server
```

`TRANSPORT` can be `stdio`, `sse`, `streamingHttp` or `streamingHttpJson` (default).

### Transport Endpoints

The different transport types use the following endpoints:
- SSE: `/sse` (with message endpoint at `/message`)
- Streamable HTTP: `/mcp` (regular or JSON mode)
- STDIO: Uses stdin/stdout directly, no HTTP endpoint

### Stateful Connection Management

The `sse` and `streamingHttp` transports are both _stateful_ - they maintain a connection with the MCP Client through an SSE connection. When using these transports, the following configuration options take effect:

| Environment Variable              | Default | Description |
|-----------------------------------|---------|-------------|
| `MCP_CLIENT_HEARTBEAT_INTERVAL`   | 30000ms | How often to check SSE connection health |
| `MCP_CLIENT_CONNECTION_CHECK`     | 90000ms | How often to check for stale sessions |
| `MCP_CLIENT_CONNECTION_TIMEOUT`   | 300000ms | Remove sessions inactive for this duration |
| `MCP_PING_ENABLED`                | true    | Enable ping keep-alive for sessions |
| `MCP_PING_INTERVAL`               | 30000ms | Interval between ping cycles | 


### Environment Variables

The server respects the following environment variables:
- `TRANSPORT`: The transport type to use (stdio, sse, streamableHttp, or streamableHttpJson)
- `DEFAULT_HF_TOKEN`: ⚠️ Requests are serviced with the HF_TOKEN received in the Authorization: Bearer header. The DEFAULT_HF_TOKEN is used if no header was sent. Only set this in Development / Test environments or for local STDIO Deployments. ⚠️
- If running with `stdio` transport, `HF_TOKEN` is used if `DEFAULT_HF_TOKEN` is not set.
- `HF_API_TIMEOUT`: Timeout for Hugging Face API requests in milliseconds (default: 12500ms / 12.5 seconds)
- `USER_CONFIG_API`: URL to use for User settings (defaults to Local front-end)
- `MCP_STRICT_COMPLIANCE`: set to True for GET 405 rejects in JSON Mode (default serves a welcome page).
- `AUTHENTICATE_TOOL`: whether to include an `Authenticate` tool to issue an OAuth challenge when called
- `SEARCH_ENABLES_FETCH`: When set to `true`, automatically enables the `hf_doc_fetch` tool whenever `hf_doc_search` is enabled
