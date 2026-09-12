import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import { FileCartStore, NullCartStore } from '../src/storage/cart-store.js';
import { resolveCart } from '../src/tools/cart.js';
import type { SelverClient } from '../src/selver/client.js';

/** A client that hands out a fresh token each time createCart is called. */
function fakeClient() {
  let n = 0;
  return {
    created: () => n,
    client: { createCart: async () => `tok-${++n}` } as unknown as SelverClient,
  };
}

describe('NullCartStore', () => {
  it('never remembers anything', async () => {
    const s = new NullCartStore();
    await s.write('tok-abc');
    expect(await s.read()).toBeNull();
  });
});

describe('FileCartStore', () => {
  it('round-trips a token and clears it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'selver-store-'));
    const s = new FileCartStore(dir);
    expect(await s.read()).toBeNull();
    await s.write('tok-xyz');
    expect(await s.read()).toBe('tok-xyz');
    await s.clear();
    expect(await s.read()).toBeNull();
  });
});

describe('resolveCart precedence', () => {
  it('prefers a caller-supplied token over everything', async () => {
    const { client, created } = fakeClient();
    const store = new FileCartStore(await fs.mkdtemp(path.join(os.tmpdir(), 's-')));
    await store.write('stored');
    expect(await resolveCart(client, store, 'supplied')).toBe('supplied');
    expect(created()).toBe(0); // no cart created
  });

  it('falls back to the store when no token is supplied', async () => {
    const { client, created } = fakeClient();
    const store = new FileCartStore(await fs.mkdtemp(path.join(os.tmpdir(), 's-')));
    await store.write('stored');
    expect(await resolveCart(client, store)).toBe('stored');
    expect(created()).toBe(0);
  });

  it('creates a new cart when nothing is supplied or stored', async () => {
    const { client } = fakeClient();
    const store = new FileCartStore(await fs.mkdtemp(path.join(os.tmpdir(), 's-')));
    expect(await resolveCart(client, store)).toBe('tok-1');
    expect(await store.read()).toBe('tok-1'); // and remembers it
  });

  // This is the property that makes the HTTP server safe to share.
  it('ISOLATION: with NullCartStore,each caller gets its own cart', async () => {
    const { client } = fakeClient();
    const a = await resolveCart(client, new NullCartStore());
    const b = await resolveCart(client, new NullCartStore());
    expect(a).toBe('tok-1');
    expect(b).toBe('tok-2');
    expect(a).not.toBe(b); // two callers never share a basket
  });

  it('ISOLATION: a caller that supplies its token keeps using it', async () => {
    const { client, created } = fakeClient();
    const store = new NullCartStore();
    expect(await resolveCart(client, store, 'mine')).toBe('mine');
    expect(await resolveCart(client, store, 'mine')).toBe('mine');
    expect(created()).toBe(0);
  });
});
