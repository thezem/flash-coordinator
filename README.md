<p align="center"><img src="assets/social-card.png" alt="Flash Coordinator: context in, next move out" width="100%"></p>

# Flash Coordinator

**Give your AI worker a sharp second mind that remembers the task and tells it what to do next.**

An MCP stdio server for ongoing task coordination, powered by `deepseek/deepseek-v4.1-flash` through Vercel AI Gateway. Your worker brings context and evidence. Flash responds with a concrete next move, practical instructions, and candid coaching.

## Why it exists

A worker can execute tools and still lose the thread. Flash keeps the goal, constraints, previous decisions, and unfinished work together under one task ID.

- **A conversation, not a decision tree.** Free-form guidance without classifications or predefined answers.
- **Memory across restarts.** Reuse a task ID to send earlier exchanges with each update.
- **Personality with a purpose.** Specific praise for progress; direct correction for unsupported claims and avoidable mistakes.
- **Short guidance.** Prompt target below 1,000 characters; Zod hard limit of 1,900. Reasoning is explicitly disabled on every request.
- **Know when to skip it.** Clear, routine edits get a one-sentence instruction to handle them directly.

## Start in three commands

Requires Node.js 24+ and a Vercel AI Gateway key. Set `AI_GATEWAY_API_KEY` or `VERCEL_AI_GATEWAY_API_KEY` in your environment before starting. Never commit your key.

```bash
git clone https://github.com/thezem/flash-coordinator.git && cd flash-coordinator
npm ci
npm start
```

`npm start` runs the stdio server, so it waits for an MCP client rather than opening a chat prompt.

### Connect your worker

For MCP clients using JSON configuration, replace the path with your checkout:

```json
{
  "mcpServers": {
    "flash_coordinator": {
      "command": "node",
      "args": ["/absolute/path/flash-coordinator/server.mjs"]
    }
  }
}
```

The server process must inherit the Gateway key. If your client does not inherit your shell environment, use its environment configuration or secret store.

For Codex, add to `~/.codex/config.toml`:

```toml
[mcp_servers.flash_coordinator]
command = "node"
args = ["/absolute/path/flash-coordinator/server.mjs"]
env_vars = ["AI_GATEWAY_API_KEY", "VERCEL_AI_GATEWAY_API_KEY"]
startup_timeout_sec = 30
tool_timeout_sec = 210
```

Restart Codex to discover the tools. Alternatively, after `npm ci`, `node install.mjs` copies the app to `~/.local/share/flash-coordinator/app` and appends a Codex entry with a config backup. This installer expects an existing `~/.codex/config.toml` and refuses to overwrite an existing coordinator entry.

## The coordination loop

**Get the guide → send context → execute → bring back evidence.**

| Tool | What the worker gets |
| --- | --- |
| `get_guide` | Local instructions for when and how to use Flash. No model call. |
| `coordinate_task` | Free-form next steps from DeepSeek, with earlier exchanges included for the same task ID. |
| `get_task_context` | Saved turn count and last guidance. Add `include_messages: true` for the transcript. No model call. |

Start by calling `get_guide` with `{}`. Quote the human’s original request in your first context, and quote later steering or scope changes in the next update. Redact secrets in quotations and mark the redaction.

```json
{
  "task_id": "thread-123-checkout",
  "context": "User prompt: \"Fix checkout without deploying.\" Current state: payment succeeds but confirmation never appears. Evidence: callback returns 200; UI remains pending. What should I do next?"
}
```

Reuse that ID for progress updates. Omit it for a stateless call. IDs accept 1–128 letters, digits, hyphens, or underscores and must start with a letter or digit. The worker remains responsible for execution, authorization, and evidence; coordinator advice grants no approval.

## Try the optional playground

```bash
npm run ui
```

Open **http://127.0.0.1:4319**. Enter a task ID and context to inspect the response, turn count, and raw MCP result. The playground calls the real stdio server through the MCP SDK. It is a testing harness; the MCP is the product. Keys stay on the server. Each submitted coordination request incurs Gateway usage.

## What is stored and sent

Task transcripts are stored under `~/.local/share/flash-coordinator/tasks`, with owner-only permissions. Override this using `FLASH_COORDINATOR_DATA_DIR`. Clients sharing this directory share histories; choose different task IDs for unrelated work.

Every coordination request sends current context and the task’s full earlier exchanges to Vercel AI Gateway. Do not include secrets or material you cannot send to that provider. Transcript deletion is manual; there is no automatic retention policy.

Filesystem locks prevent concurrent updates to a task. History has a local 2 MB limit; exceeding it requires a new task ID with a handoff rather than silent truncation. All attempts share a 180-second deadline. Failed, empty, incomplete, or oversized responses save no new turn. A response exceeding 1,900 characters triggers up to two automatic retries with a shorter-response reminder. After three oversized attempts, the call returns an error. Failed attempts are never appended to history, and responses are never truncated. Other failures do not trigger these retries. Retries can incur additional Gateway usage; result metadata includes `attempt_count` and `attempts_usage`.

## Make it yours

Edit `personality.txt` to tune the coordinator’s voice and instructions. The model ID and request parameters live in `server.mjs`. The prompt directs Flash to preserve the user’s scope, proceed with reasonable assumptions, and avoid unnecessary clarification questions. These are model instructions, not guarantees of behavior.

```text
server.mjs        MCP tools, Gateway requests, task persistence
personality.txt   Coordinator instructions and voice
ui.mjs            Optional stdio testing harness
index.html        Playground interface
install.mjs       Optional Codex installer
verify.mjs        Opt-in, metered stdio E2E script
assets/           Social card and sharing copy
```

## Status

Experimental. This presentation pass did not run functionality tests. `npm run verify` is an opt-in live E2E script that uses temporary task storage, calls the Gateway, and writes evidence; it costs API usage. Historical checks from development are not claims about the current model configuration.

No license is included yet; repository access alone does not grant an open-source license.
