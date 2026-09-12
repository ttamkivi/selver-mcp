#!/usr/bin/env node
// src/http.ts
//
// The same MCP server, reachable over HTTP so systems other than a local
// Claude Desktop can use it.
//
// Stateless by construction: no Mcp-Session-Id is issued, no SSE stream is
// offered, every request authenticates itself and carries its own cart token.
// Two callers cannot collide because the server holds nothing about either.
//
//   SELVER_MCP_TOKEN   required. No token set => 503 on every request.
//   PORT               default 8080
//
// Endpoints:
//   POST /mcp      JSON-RPC (initialize, tools/list, tools/call)
//   GET  /health   liveness, unauthenticated, reveals nothing

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SelverClient } from './selver/client.js';
import { registerSearchTools } from './tools/search.js';
import { registerCartTools } from './tools/cart.js';
import { NullCartStore } from './storage/cart-store.js';

const PORT = Number(process.env.PORT ?? 8080);
const TOKEN = process.env.SELVER_MCP_TOKEN ?? '';
const MAX_BODY = 1_000_000; // 1 MB is far more than any tools/call needs

/** Constant-time compare that does not leak length via early return. */
function tokenOk(presented: string): boolean {
  if (!TOKEN) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(TOKEN);
  if (a.length !== b.length) {
    // still burn a comparison so timing does not distinguish wrong-length
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** A fresh server per request — no cross-request state to leak or race. */
function buildServer(): McpServer {
  const server = new McpServer({ name: 'selver-mcp', version: '0.1.0' });
  const client = new SelverClient();
  registerSearchTools(server, client);
  registerCartTools(server, client, new NullCartStore());
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/health') {
    // Deliberately says nothing about whether a token is configured.
    return send(res, 200, { status: 'ok', server: 'selver-mcp' });
  }

  if (url.pathname !== '/mcp') return send(res, 404, { error: 'Not found' });

  // Fail closed. An unset secret must never mean "open to everyone".
  if (!TOKEN) {
    return send(res, 503, { error: 'SELVER_MCP_TOKEN is not configured; refusing all requests' });
  }
  if (!tokenOk(bearer(req))) {
    res.setHeader('WWW-Authenticate', 'Bearer');
    return send(res, 401, { error: 'Unauthorized' });
  }
  if (req.method !== 'POST') {
    // No GET: stateless means no server-initiated SSE stream to resume.
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Method not allowed; POST JSON-RPC to /mcp' });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch (e) {
    return send(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: `Parse error: ${(e as Error).message}` },
      id: null,
    });
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,   // stateless
    enableJsonResponse: true,        // plain JSON back, no SSE
  });

  res.on('close', () => { void transport.close(); void server.close(); });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  } catch (e) {
    if (!res.headersSent) {
      send(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal error: ${(e as Error).message}` },
        id: null,
      });
    }
  }
});

http.listen(PORT, () => {
  const state = TOKEN ? 'authenticated' : 'REFUSING ALL REQUESTS (SELVER_MCP_TOKEN unset)';
  console.error(`selver-mcp http on :${PORT} — ${state}`);
});
