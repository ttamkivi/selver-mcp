// src/tools/cart.ts
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SelverClient } from '../selver/client.js';
import type { CartStore } from '../storage/cart-store.js';
import { FileCartStore } from '../storage/cart-store.js';

/**
 * Resolve which cart to act on, most explicit first:
 *   1. a token the caller passed in       (stateless HTTP callers)
 *   2. a token the store remembers        (stdio, single user)
 *   3. a brand new cart
 */
export async function resolveCart(
  client: SelverClient,
  store: CartStore,
  supplied?: string,
): Promise<string> {
  if (supplied) return supplied;
  const existing = await store.read();
  if (existing) return existing;
  const token = await client.createCart();
  if (!token) throw new Error('Failed to create Selver cart');
  await store.write(token);
  return token;
}

const CART_TOKEN_DESC =
  'Existing Selver guest-cart token. Required when talking to a shared HTTP server, '
  + 'which keeps no state — pass back the cart_token returned by a previous call. '
  + 'Omit on a local stdio server, which remembers your cart.';

export function registerCartTools(
  server: McpServer,
  client: SelverClient,
  store: CartStore = new FileCartStore(),
): void {
  server.tool(
    'add_to_cart',
    'Add products to Selver.ee guest cart by SKU. Creates a new cart if none exists. Server-side only - if a browser is open on selver.ee/cart, you must ALSO dispatch cart/addItem via chrome-devtools-mcp to keep the browser in sync (see README).',
    {
      items: z.array(z.object({
        sku: z.string().describe('Product SKU (e.g. "T000089179")'),
        qty: z.number().describe('Quantity to add'),
      })),
      cart_token: z.string().optional().describe(CART_TOKEN_DESC),
    },
    async (params) => {
      let token: string;
      try {
        token = await resolveCart(client, store, params.cart_token);
      } catch (e) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: (e as Error).message }) }],
        };
      }

      const added: string[] = [];
      const failed: Array<{ sku: string; error: string }> = [];

      for (const item of params.items) {
        const r = await client.addToCart(token, item.sku, item.qty);
        if (r.ok) {
          added.push(item.sku);
        } else {
          failed.push({ sku: item.sku, error: r.error ?? 'Add failed' });
        }
      }

      const allLookLikeExpiredToken = added.length === 0 && failed.length > 0
        && failed.every(f => !/samm|step|stock|quantity|kogus/i.test(f.error));
      if (allLookLikeExpiredToken) {
        await store.clear();
        const newToken = await client.createCart();
        if (newToken) {
          token = newToken;
          await store.write(token);
          added.length = 0;
          failed.length = 0;
          for (const item of params.items) {
            const r = await client.addToCart(token, item.sku, item.qty);
            if (r.ok) {
              added.push(item.sku);
            } else {
              failed.push({ sku: item.sku, error: r.error ?? 'Add failed after cart retry' });
            }
          }
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ added, failed, cart_token: token }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'view_cart',
    'View current Selver.ee cart contents and total price.',
    {
      cart_token: z.string().optional().describe(CART_TOKEN_DESC),
    },
    async (params) => {
      const token = params.cart_token ?? await store.read();
      if (!token) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No active cart. Use add_to_cart first, or pass cart_token.' }) }],
        };
      }
      const items = await client.getCart(token);
      const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ items, total: Math.round(total * 100) / 100, total_excludes_vat: true, cart_token: token }, null, 2),
        }],
      };
    }
  );

  server.tool(
    'remove_from_cart',
    'Remove products from Selver.ee cart by SKU. Server-side only - if a browser is open on selver.ee/cart, you must ALSO dispatch cart/removeItem via chrome-devtools-mcp to keep the browser in sync (see README).',
    {
      items: z.array(z.object({
        sku: z.string().describe('Product SKU to remove'),
      })),
      cart_token: z.string().optional().describe(CART_TOKEN_DESC),
    },
    async (params) => {
      const token = params.cart_token ?? await store.read();
      if (!token) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No active cart. Pass cart_token if using a shared HTTP server.' }) }],
        };
      }

      const cartItems = await client.getCart(token);
      const removed: string[] = [];
      const failed: Array<{ sku: string; error: string }> = [];

      for (const req of params.items) {
        const match = cartItems.find(ci => ci.sku === req.sku);
        if (!match) {
          failed.push({ sku: req.sku, error: 'Item not found in cart' });
          continue;
        }
        const ok = await client.deleteCartItem(token, req.sku, match.item_id);
        if (ok) {
          removed.push(req.sku);
        } else {
          failed.push({ sku: req.sku, error: 'Delete failed' });
        }
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ removed, failed, cart_token: token }, null, 2),
        }],
      };
    }
  );

}
