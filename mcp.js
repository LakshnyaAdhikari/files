// src/mcp.js
// Owns the connection to the refund-desk MCP server, spawned locally
// over stdio -- same shape as the reference GitHub agent's mcp.js.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let mcpClient = null;
let mcpTransport = null;

export async function connectRefundMcp() {
  if (mcpClient) return mcpClient;

  mcpTransport = new StdioClientTransport({
    command: 'node',
    args: ['refund-mcp-server.js'],
    env: { ...process.env },
  });

  mcpClient = new Client(
    { name: 'armoriq-refund-agent', version: '1.0.0' },
    { capabilities: {} }
  );
  await mcpClient.connect(mcpTransport);
  return mcpClient;
}

export async function callTool(toolName, args) {
  return mcpClient.callTool({ name: toolName, arguments: args });
}

export async function disconnectRefundMcp() {
  if (mcpTransport) {
    await mcpTransport.close();
    mcpTransport = null;
    mcpClient = null;
  }
}
