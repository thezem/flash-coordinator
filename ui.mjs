import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
const client = new Client({ name: 'flash-test-harness', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./server.mjs', import.meta.url))], env: Object.fromEntries(Object.entries(process.env).filter(([,v]) => v !== undefined)), stderr: 'inherit' });
await client.connect(transport);
const port = Number(process.env.FLASH_UI_PORT || 4319);
const base = `http://127.0.0.1:${port}`;
const app = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); return res.end(); }
  try {
    if (req.method === 'GET' && req.url === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(await readFile(new URL('./index.html', import.meta.url))); }
    if (req.method === 'POST' && ['/api/coordinate', '/api/task'].includes(req.url)) {
      if (req.headers.origin !== base || !req.headers['content-type']?.startsWith('application/json')) { res.writeHead(403); return res.end(); }
      let body = ''; for await (const part of req) { body += part; if (body.length > 210000) { res.writeHead(413); return res.end(); } }
      const input = JSON.parse(body);
      const result = await client.callTool({ name: req.url === '/api/task' ? 'get_task_context' : 'coordinate_task', arguments: input }, undefined, { timeout: 190000 });
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(result));
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
});
app.listen(port, '127.0.0.1', () => console.log(`Flash test UI: ${base}\nRequests use the MCP SDK and a real stdio child process.`));
async function stop() { app.close(); await client.close(); process.exit(0); }
process.on('SIGTERM', stop); process.on('SIGINT', stop);
