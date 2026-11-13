import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { loadConfig } from '../src/config.ts';
import { Store } from '../src/db.ts';
import { Bus } from '../src/events.ts';
import { cancelDigest } from '../src/orders.ts';
import { createApp, type ServerDeps } from '../src/server.ts';
import { CANCEL_TYPES, orderDomain } from '../src/shared/eip712.ts';
import { checkOrderSignature } from '../src/signature.ts';
import type { SnapshotService } from '../src/snapshot.ts';
import { CONTRACT, NVDAC, PK1, USDC, fakeClient } from './helpers.ts';

const maker = privateKeyToAccount(PK1);
const HASH = ('0x' + 'ab'.repeat(32)) as Hex;
const client = fakeClient({ code: new Map(), wallets: new Map() });

function setup(enabled: boolean) {
  const store = new Store(':memory:');
  const cfg = { ...loadConfig({}), lastprintAddress: enabled ? CONTRACT : null };
  const snapshots = { get: () => ({ updatedAt: 1, market: { open: false }, markets: [] }) } as unknown as SnapshotService;
  const deps: ServerDeps = {
    cfg,
    store,
    bus: new Bus(),
    snapshots,
    checkSignature: (m, d, s) => checkOrderSignature(client, m, d, s),
    keeperMode: enabled ? 'watch' : 'off',
    telegramBot: null,
    intake: enabled
      ? {
          chainId: 8453,
          contract: CONTRACT,
          markets: [],
          marketContext: () => {
            throw new Error('unused');
          },
          chain: {} as never,
          guardWindowSec: 86_400n,
          openOrdersOf: () => 0,
          nonceKnown: () => false,
        }
      : null,
  };
  store.insertOrder({
    hash: HASH,
    maker: maker.address.toLowerCase(),
    ticker: 'NVDA',
    side: 'buy',
    token_in: USDC.toLowerCase(),
    token_out: NVDAC.toLowerCase(),
    amount_in: '1000000000',
    min_amount_out: '600000000',
    stock_token: NVDAC.toLowerCase(),
    stock_multiplier: '1000537939576369481',
    valid_after: 1_794_517_200,
    valid_until: 1_794_580_200,
    nonce: '7',
    signature: '0xsecret',
    status: 'open',
    created_at: 1,
    updated_at: 1,
  });
  return { app: createApp(deps), store };
}

describe('HTTP API', () => {
  it('read-only mode: markets served, ordering disabled with a plain message', async () => {
    const { app } = setup(false);
    const cfg = await (await app.request('/v1/config')).json();
    assert.equal(cfg.orderingEnabled, false);
    assert.equal(cfg.contract, null);
    assert.equal((await app.request('/v1/markets')).status, 200);
    const r = await app.request('/v1/orders', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /not enabled/);
  });

  it('lists orders by maker without exposing signatures', async () => {
    const { app } = setup(true);
    const r = await app.request(`/v1/orders?maker=${maker.address}`);
    const body = await r.json();
    assert.equal(body.orders.length, 1);
    assert.equal(body.orders[0].hash, HASH);
    assert.equal(JSON.stringify(body).includes('secret'), false);
    assert.equal((await app.request('/v1/orders?maker=nope')).status, 400);
    assert.equal((await app.request(`/v1/orders/${HASH}`)).status, 200);
    assert.equal((await app.request(`/v1/orders/0x${'cd'.repeat(32)}`)).status, 404);
  });

  it('offchain cancel requires the maker signature over CancelOrder(orderHash)', async () => {
    const { app, store } = setup(true);
    const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8416f8e3e2d8f7b6c1');
    const typed = { domain: orderDomain(8453, CONTRACT), types: CANCEL_TYPES, primaryType: 'CancelOrder' as const, message: { orderHash: HASH } };
    const bad = await other.signTypedData(typed);
    const r1 = await app.request(`/v1/orders/${HASH}/cancel`, { method: 'POST', body: JSON.stringify({ signature: bad }), headers: { 'content-type': 'application/json' } });
    assert.equal(r1.status, 401);
    assert.equal(store.getOrder(HASH)!.status, 'open');

    const good = await maker.signTypedData(typed);
    assert.ok(cancelDigest(HASH, 8453, CONTRACT));
    const r2 = await app.request(`/v1/orders/${HASH}/cancel`, { method: 'POST', body: JSON.stringify({ signature: good }), headers: { 'content-type': 'application/json' } });
    assert.equal(r2.status, 200);
    assert.match((await r2.json()).note, /onchain/);
    assert.equal(store.getOrder(HASH)!.status, 'cancelled');
  });

  it('stats come from indexed fills', async () => {
    const { app, store } = setup(true);
    store.insertFill({ tx_hash: '0x01', log_index: 0, order_hash: HASH, maker: '0xaa', token_in: USDC.toLowerCase(), token_out: NVDAC.toLowerCase(), amount_in: '1000000000', amount_out: '6', filler: '0xff', block_number: 1 });
    store.insertFill({ tx_hash: '0x02', log_index: 0, order_hash: '0x02', maker: '0xbb', token_in: NVDAC.toLowerCase(), token_out: USDC.toLowerCase(), amount_in: '1', amount_out: '500000000', filler: '0xff', block_number: 2 });
    const s = await (await app.request('/v1/stats')).json();
    assert.equal(s.fills, 2);
    assert.equal(s.volumeUsd, 1500);
    assert.equal(s.uniqueMakers, 2);
    assert.equal(s.ordersCreated, 1);
  });

  it('static server refuses path traversal and unknown types; sets security headers', async () => {
    const { app } = setup(false);
    assert.equal((await app.request('/../src/config.ts')).status, 404);
    assert.equal((await app.request('/%2e%2e/package.json')).status, 404);
    const r = await app.request('/v1/health');
    assert.match(r.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });

  it('rejects oversized bodies', async () => {
    const { app } = setup(true);
    const big = JSON.stringify({ order: {}, signature: '0x' + '00'.repeat(40_000) });
    const r = await app.request('/v1/orders', { method: 'POST', body: big, headers: { 'content-type': 'application/json', 'content-length': String(big.length) } });
    assert.equal(r.status, 413);
  });
});
