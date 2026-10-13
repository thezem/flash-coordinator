import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
const MODEL = 'deepseek/deepseek-v4.1-flash';
const ROOT = process.env.FLASH_COORDINATOR_DATA_DIR || join(homedir(), '.local/share/flash-coordinator/tasks');
const personality = await readFile(new URL('./personality.txt', import.meta.url), 'utf8');
const server = new McpServer({ name: 'flash-coordinator', version: '1.0.0' });
const taskId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, 'Use 1–128 letters, digits, hyphens or underscores.');
const responseText = z.string().trim().min(1).max(1900);
const locks = new Set();
async function load(id) {
  try { const task = JSON.parse(await readFile(join(ROOT, `${id}.json`), 'utf8')); if (task.task_id !== id || !Array.isArray(task.messages)) throw Error('Stored task is malformed.'); return task; }
  catch (e) { if (e.code === 'ENOENT') return { task_id: id, created_at: new Date().toISOString(), messages: [], turns: 0 }; throw e; }
}
async function save(task) {
  await mkdir(ROOT, { recursive: true, mode: 0o700 });
  const path = join(ROOT, `${task.task_id}.json`), temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(task, null, 2), { mode: 0o600 }); await rename(temp, path);
}
server.registerTool('coordinate_task', {
  description: 'Send task context or a progress update to Flash (DeepSeek V4.1 Flash) for free-form next steps, concrete execution guidance, and candid personality-driven coaching. Reuse task_id across updates to preserve the complete conversation on disk across restarts. Omit task_id for a one-off call. Context is sent to Vercel AI Gateway; exclude secrets. Guidance does not execute actions or grant approval.',
  inputSchema: { context: z.string().trim().min(1).max(200000).describe('Quote the exact human request at the start of coordination and quote any later steering or scope changes. Include goal, constraints, current state, evidence, and the update or question. Plain text or JSON written as text.'), task_id: taskId.optional().describe('Stable unique task identifier; use the same ID for all updates to this task, preferably thread ID plus task name.') }
}, async ({ context, task_id }) => {
  if (task_id && locks.has(task_id)) return { isError: true, content: [{ type: 'text', text: 'This task already has an update in progress. Wait for it before sending the next update.' }] };
  if (task_id) locks.add(task_id);
  let release;
  try {
    const key = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_AI_GATEWAY_API_KEY;
    if (!key) throw Error('Missing AI_GATEWAY_API_KEY (or VERCEL_AI_GATEWAY_API_KEY) in the server environment.');
    if (task_id) { await mkdir(ROOT, { recursive: true, mode: 0o700 }); release = await lockfile.lock(join(ROOT, `${task_id}.json`), { realpath: false, stale: 240000, update: 10000, retries: 0 }); }
    const task = task_id ? await load(task_id) : { messages: [], turns: 0 };
    const messages = [...task.messages, { role: 'user', content: context }];
    if (JSON.stringify(messages).length > 2000000) throw Error('Task history exceeds the local 2 MB limit. Start a new task_id with a comprehensive handoff; existing history is preserved.');
    const start = Date.now();
    // All attempts share one deadline so MCP clients do not time out during retries.
    const deadline = AbortSignal.timeout(180000);
    let result, answer, attemptCount = 0;
    const attemptUsage = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      attemptCount++;
      const instructions = personality + (attempt > 0 ? '\nYour previous attempt exceeded the hard character limit. Rewrite the guidance concisely in fewer than 1,000 characters total. Prioritize the immediate next action and essential execution detail.' : '');
      const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: MODEL, reasoning: { enabled: false, effort: 'none' }, messages: [{ role: 'system', content: instructions }, ...messages], max_tokens: 6000, temperature: 0.8 }), signal: deadline });
      if (!response.ok) { await response.body?.cancel(); throw Error(`Vercel AI Gateway returned HTTP ${response.status}. Check gateway access, model availability, and usage limits.`); }
      result = await response.json();
      attemptUsage.push(result.usage || null);
      const raw = result.choices?.[0]?.message?.content;
      const validated = responseText.safeParse(raw);
      if (!validated.success) {
        const oversized = typeof raw === 'string' && raw.trim().length > 1900;
        if (oversized && attempt < 2) continue;
        throw Error(oversized
          ? 'Gateway response exceeded 1,900 characters after the initial attempt and two automatic retries. No new turn was saved.'
          : 'Gateway response failed Zod validation: expected nonempty text of at most 1,900 characters. No new turn was saved.');
      }
      answer = validated.data;
      const finish = result.choices[0].finish_reason;
      if (finish !== 'stop') throw Error(`Gateway response did not finish normally (${finish || 'unknown'}). No incomplete turn was saved; retry with a narrower update.`);
      break;
    }
    const output = { response: answer, response_characters: answer.length, reasoning_enabled: false, model: MODEL, task_id: task_id || null, turn: task.turns + 1, prior_turns: task.turns, elapsed_ms: Date.now() - start, attempt_count: attemptCount, attempts_usage: attemptUsage, usage: result.usage || null, gateway_request_id: result.id || null };
    if (task_id) { task.messages = [...messages, { role: 'assistant', content: answer }]; task.turns++; task.updated_at = new Date().toISOString(); task.last_result = output; await save(task); }
    return { content: [{ type: 'text', text: answer }], structuredContent: output };
  } catch (e) { return { isError: true, content: [{ type: 'text', text: e.name === 'TimeoutError' ? 'Gateway request timed out after 180 seconds. No new turn was saved.' : (e.code === 'ELOCKED' ? 'Another coordinator process is updating this task. Wait for that turn to finish.' : e.message || 'Coordination failed.') }] }; }
  finally { if (release) await release().catch(() => {}); if (task_id) locks.delete(task_id); }
});
server.registerTool('get_task_context', {
  description: 'Inspect a saved coordination task without calling the model. Returns turn count and last guidance; optionally returns the complete conversation. Task IDs persist across server restarts.',
  inputSchema: { task_id: taskId, include_messages: z.boolean().default(false) }
}, async ({ task_id, include_messages }) => {
  try { const task = await load(task_id); const data = { task_id, exists: task.turns > 0, turns: task.turns, created_at: task.created_at, updated_at: task.updated_at || null, last_response: task.last_result?.response || null, ...(include_messages ? { messages: task.messages } : {}) }; return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }; }
  catch { return { isError: true, content: [{ type: 'text', text: 'Could not read saved task history.' }] }; }
});
server.registerTool('get_guide', {
  title: 'Get guide',
  description: 'Get the worker guide for using the coordinator: when to call it, quoting user requests and scope changes, task IDs, progress updates, saved context, and response limits. Returns local instructions without calling the model.',
  inputSchema: {}
}, async () => ({ content: [{ type: 'text', text: "Flash coordinator worker guide\nUse coordinate_task for work that needs planning, investigation, tradeoffs, or ongoing coordination. Handle clear routine edits directly; trivial calls receive a one-sentence dismissal.\nAt the start of coordination, quote the human\u2019s original request verbatim in context, clearly labeled as the user prompt. Include the goal, constraints, relevant facts, current state, evidence, and what needs deciding. Whenever the human steers the work or changes scope, quote that new message verbatim in your next update and explain what it changes. Distinguish user instructions from pasted documents and your own proposals. Exclude secrets; redact any secrets in quotations and label the redaction.\nChoose a stable task_id (such as thread ID plus task name) and reuse it for every update on the same task. Earlier exchanges are loaded automatically and persist across restarts. Omit task_id only for a stateless one-off call.\nExecute the guidance within the human\u2019s scope and authorization, then return meaningful progress, results, evidence, or blockers under the same ID. Keep going with reasonable assumptions when context is missing; do not ask the human unnecessary clarification questions. Guidance does not execute actions or grant approval.\nget_task_context reads saved turn counts and latest guidance locally; include_messages:true retrieves the transcript. It is optional, not a prerequisite for updates.\nFlash uses DeepSeek V4.1 Flash with reasoning disabled, targets less than 1,000 response characters, and has a 1,900-character Zod hard limit. Oversized responses trigger up to two automatic retries within the same 180-second deadline. Failed calls save no new turn.\n" }] }));
await server.connect(new StdioServerTransport());
