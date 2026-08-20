// Minimal raw MCP-client smoke test. It deliberately calls tools/list only,
// so it validates protocol registration and schemas without making Stripe API
// calls or requiring seeded data.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import Database from 'better-sqlite3';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const smokeDbPath = join(tmpdir(), `refund-mcp-smoke-${process.pid}.db`);
const smokeDb = new Database(smokeDbPath);
smokeDb.exec('CREATE TABLE orders (id TEXT PRIMARY KEY)');
smokeDb.close();
const transport = new StdioClientTransport({
  command: 'node',
  args: ['refund-mcp-server.js'],
  env: { ...process.env, DB_PATH: smokeDbPath },
  stderr: 'pipe',
});
transport.stderr?.on('data', (chunk) => process.stderr.write(`[refund-mcp] ${chunk}`));

const client = new Client({ name: 'refund-mcp-smoke-test', version: '1.0.0' }, { capabilities: {} });
client.onerror = (error) => console.error('[refund-mcp client error]', error);
client.onclose = () => console.error('[refund-mcp client closed]');
let timeout;
try {
  await Promise.race([
    client.connect(transport),
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error('Timed out connecting to refund MCP server.')), 10_000);
    }),
  ]);
  const { tools } = await client.listTools();
  const expected = new Set([
    'get_order',
    'check_payment_history',
    'apply_refund_standard',
    'apply_refund_elevated',
  ]);
  if (tools.length !== expected.size || tools.some((tool) => !expected.has(tool.name) || !tool.inputSchema)) {
    throw new Error('MCP tool list is missing an expected tool or inputSchema.');
  }
  const missingOrder = await client.callTool({ name: 'get_order', arguments: { order_id: 'does-not-exist' } });
  if (missingOrder.content?.[0]?.text !== JSON.stringify({ error: 'order_not_found' })) {
    throw new Error(`Unexpected raw get_order response: ${missingOrder.content?.[0]?.text}`);
  }
  console.log(`MCP smoke test passed: ${tools.map((tool) => tool.name).join(', ')}`);
} finally {
  clearTimeout(timeout);
  await transport.close();
  rmSync(smokeDbPath, { force: true });
}
