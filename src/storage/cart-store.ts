// src/storage/cart-store.ts
//
// Where a guest-cart token lives between calls.
//
// The stdio server runs as one process for one person, so a file on that
// machine is the right answer. An HTTP server reachable from several systems
// is not: a single shared token would put every caller's items in the same
// basket and interleave concurrent edits. There, the caller carries its own
// token and the server keeps nothing.

import { readCartToken, writeCartToken, clearCartToken } from './cart-token.js';

export interface CartStore {
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Persists to ~/.selver-mcp/cart.json. Single-user, single-machine. */
export class FileCartStore implements CartStore {
  constructor(private readonly dataDir?: string) {}
  read() { return readCartToken(this.dataDir); }
  write(token: string) { return writeCartToken(token, this.dataDir); }
  clear() { return clearCartToken(this.dataDir); }
}

/**
 * Remembers nothing. Every call must carry its own `cart_token`, and tools
 * return the token so the caller can hold it. This is what makes the HTTP
 * server safe to share: two callers cannot collide because the server has no
 * idea either of them exists.
 */
export class NullCartStore implements CartStore {
  async read(): Promise<string | null> { return null; }
  async write(): Promise<void> { /* deliberately nothing */ }
  async clear(): Promise<void> { /* deliberately nothing */ }
}
