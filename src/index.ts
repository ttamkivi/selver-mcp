#!/usr/bin/env node
// src/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SelverClient } from './selver/client.js';
import { registerSearchTools } from './tools/search.js';
import { registerCartTools } from './tools/cart.js';
import { FileCartStore } from './storage/cart-store.js';

const server = new McpServer({
  name: 'selver-mcp',
  version: '0.1.0',
});

const client = new SelverClient();

registerSearchTools(server, client);
// stdio: one process, one person — a file on this machine is the right store.
registerCartTools(server, client, new FileCartStore());

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
