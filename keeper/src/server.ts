import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { BASE, type Config } from './config.ts';
import type { OrderRow, Store } from './db.ts';
import type { Bus, FillEvent } from './events.ts';
import { cancelDigest, intakeOrder, OrderRejected, type IntakeDeps } from './orders.ts';
import { computeStats } from './report.ts';
import { isHex } from './shared/eip712.ts';
import type { SigCheck } from './signature.ts';
import type { SnapshotService } from './snapshot.ts';

export const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

export interface ServerDeps {
  cfg: Config;
  store: Store;
  bus: Bus;
  snapshots: SnapshotService;
  /** Null when LASTPRINT_ADDRESS is unset (read-only mode). */
  intake: Omit<IntakeDeps, 'now'> | null;
  checkSignature: (maker: Address, digest: Hex, sig: Hex) => Promise<SigCheck>;
  keeperMode: 'send' | 'watch' | 'off';
  telegramBot: string | null;
  now?: () => number;
}

export function orderView(r: OrderRow) {
  return {
    hash: r.hash,
    maker: r.maker,
    ticker: r.ticker,
    side: r.side,
    tokenIn: r.token_in,
    tokenOut: r.token_out,
    amountIn: r.amount_in,
    minAmountOut: r.min_amount_out,
    stockToken: r.stock_token,
    stockMultiplier: r.stock_multiplier,
    validAfter: r.valid_after,
    validUntil: r.valid_until,
    nonce: r.nonce,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    fillTx: r.fill_tx,
    amountOut: r.amount_out,
    note: r.last_error,
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/** Minimal static file server confined to PUBLIC_DIR. */
async function serveFile(c: Context, urlPath: string): Promise<Response | null> {
  let p: string;
  try {
    p = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (p.includes('\0')) return null;
  if (p.endsWith('/')) p += 'index.html';
  const full = resolve(PUBLIC_DIR, '.' + normalize('/' + p));
  if (!full.startsWith(resolve(PUBLIC_DIR) + sep)) return null;
  const type = MIME[extname(full)];
  if (!type) return null;
  try {
    const s = await stat(full);
    if (!s.isFile()) return null;
    const body = await readFile(full);
    const cache = /\/(fonts|js)\//.test(full) ? 'public, max-age=3600' : 'no-cache';
    return c.body(body, 200, { 'content-type': type, 'cache-control': cache });
  } catch {
    return null;
  }
}

/** Fixed-window per-IP limiter for write endpoints. */
function rateLimiter(max: number, windowMs: number) {
  const hits = new Map<string, { n: number; reset: number }>();
  return (ip: string, now: number): boolean => {
    const h = hits.get(ip);
    if (!h || now >= h.reset) {
      hits.set(ip, { n: 1, reset: now + windowMs });
      if (hits.size > 10_000) for (const [k, v] of hits) if (now >= v.reset) hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= max;
  };
}

function clientIp(c: Context): string {
  // Loopback by default. Behind a reverse proxy, the proxy should set x-real-ip.
  return c.req.header('x-real-ip') ?? (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ?? 'local';
}

export function createApp(d: ServerDeps): Hono {
  const app = new Hono();
  const now = d.now ?? Date.now;
  const allowWrite = rateLimiter(30, 60_000);

  app.use('*', async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
  });
  app.use('/v1/*', bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: 'Request body too large.' }, 413) }));

  app.onError((err, c) => {
    if (err instanceof OrderRejected) return c.json({ error: err.message }, err.status as 400);
    console.error(`api error: ${err.message}`);
    return c.json({ error: 'Something went wrong on our side. Please try again.' }, 500);
  });

  app.get('/v1/health', (c) => c.json({ ok: true, time: now() }));

  app.get('/v1/config', (c) =>
    c.json({
      chainId: d.cfg.chainId,
      contract: d.cfg.lastprintAddress,
      orderingEnabled: d.intake !== null,
      router: d.cfg.router,
      actionFeed: d.cfg.actionFeed,
      guardWindowSec: d.intake ? Number(d.intake.guardWindowSec) : null,
      keeperMode: d.keeperMode,
      telegramBot: d.telegramBot,
      repoUrl: d.cfg.repoUrl,
    }),
  );

  app.get('/v1/markets', (c) => {
    const s = d.snapshots.get();
    if (!s) return c.json({ error: 'Market data is loading.' }, 503);
    return c.json(s);
  });

  app.post('/v1/orders', async (c) => {
    if (!d.intake) return c.json({ error: 'Ordering is not enabled on this instance (no contract configured).' }, 503);
    if (!allowWrite(clientIp(c), now())) return c.json({ error: 'Too many requests. Slow down.' }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Expected a JSON body.' }, 400);
    }
    const res = await intakeOrder(body, { ...d.intake, now });
    const t = now();
    try {
      d.store.insertOrder({
        hash: res.hash,
        maker: res.order.maker.toLowerCase(),
        ticker: res.terms.ticker,
        side: res.terms.side,
        token_in: res.order.tokenIn.toLowerCase(),
        token_out: res.order.tokenOut.toLowerCase(),
        amount_in: res.order.amountIn.toString(),
        min_amount_out: res.order.minAmountOut.toString(),
        stock_token: res.order.stockToken.toLowerCase(),
        stock_multiplier: res.order.stockMultiplier.toString(),
        valid_after: Number(res.order.validAfter),
        valid_until: Number(res.order.validUntil),
        nonce: res.order.nonce.toString(),
        signature: res.signature,
        status: 'open',
        created_at: t,
        updated_at: t,
      });
    } catch (e) {
      if (/UNIQUE/i.test((e as Error).message)) return c.json({ error: 'This order (or its nonce) was already submitted.' }, 409);
      throw e;
    }
    return c.json({ order: orderView(d.store.getOrder(res.hash)!) }, 201);
  });

  app.get('/v1/orders', (c) => {
    const maker = c.req.query('maker');
    if (!maker || !isAddress(maker)) return c.json({ error: 'Pass ?maker=0x… (an address).' }, 400);
    return c.json({ orders: d.store.ordersByMaker(getAddress(maker).toLowerCase()).map(orderView) });
  });

  app.get('/v1/orders/:hash', (c) => {
    const hash = c.req.param('hash');
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return c.json({ error: 'Not an order hash.' }, 400);
    const o = d.store.getOrder(hash);
    return o ? c.json({ order: orderView(o) }) : c.json({ error: 'Order not found.' }, 404);
  });

  app.post('/v1/orders/:hash/cancel', async (c) => {
    if (!d.intake) return c.json({ error: 'Ordering is not enabled on this instance.' }, 503);
    if (!allowWrite(clientIp(c), now())) return c.json({ error: 'Too many requests. Slow down.' }, 429);
    const hash = c.req.param('hash');
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return c.json({ error: 'Not an order hash.' }, 400);
    const o = d.store.getOrder(hash);
    if (!o) return c.json({ error: 'Order not found.' }, 404);
    let body: { signature?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Expected a JSON body.' }, 400);
    }
    if (!isHex(body.signature)) return c.json({ error: 'Malformed signature.' }, 400);
    const digest = cancelDigest(o.hash as Hex, d.intake.chainId, d.intake.contract);
    const check = await d.checkSignature(getAddress(o.maker), digest, body.signature);
    if (!check.ok) return c.json({ error: check.reason }, 401);
    if (o.status === 'open') d.store.setStatus(o.hash, 'cancelled', now(), { last_error: 'cancelled offchain by maker' });
    else if (o.status !== 'cancelled') return c.json({ error: `Order is ${o.status}; it cannot be cancelled.` }, 409);
    return c.json({
      order: orderView(d.store.getOrder(o.hash)!),
      note: 'This keeper will no longer fill the order. The signed order itself stays valid onchain until it expires; call cancel(nonce) on the contract for a hard guarantee.',
    });
  });

  app.get('/v1/stats', (c) => c.json(computeStats(d.store, BASE.usdc)));

  app.get('/v1/stream', (c) =>
    streamSSE(c, async (stream) => {
      const onFill = (e: FillEvent) => void stream.writeSSE({ event: 'fill', data: JSON.stringify(e) });
      d.bus.on('fill', onFill);
      stream.onAbort(() => {
        d.bus.off('fill', onFill);
      });
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ time: now() }) });
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: 'ping', data: String(now()) });
      }
    }),
  );

  // Hidden route rendered for the gap-report PNG.
  app.get('/report', async (c) => (await serveFile(c, '/report.html')) ?? c.notFound());
  app.get('/.well-known/farcaster.json', async (c) => (await serveFile(c, '/.well-known/farcaster.json')) ?? c.notFound());

  app.get('*', async (c) => (await serveFile(c, new URL(c.req.url).pathname)) ?? c.text('Not found', 404));

  return app;
}
