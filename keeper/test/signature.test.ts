import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeAbiParameters, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { orderHash } from '../src/orders.ts';
import { ORDER_TYPES, orderDomain } from '../src/shared/eip712.ts';
import { checkOrderSignature, ERC6492_SUFFIX, normalizeV } from '../src/signature.ts';
import { CONTRACT, PK1, PK2, baseOrder, fakeClient } from './helpers.ts';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const eoa = privateKeyToAccount(PK1);
const other = privateKeyToAccount(PK2);
const WALLET = '0x5ca1ab1e00000000000000000000000000000001' as Address;
const UNDEPLOYED = '0x5ca1ab1e00000000000000000000000000000002' as Address;

function sign(account = eoa, maker: Address = eoa.address) {
  const order = baseOrder(maker);
  return { order, digest: orderHash(order, 8453, CONTRACT), sigP: account.signTypedData({ domain: orderDomain(8453, CONTRACT), types: ORDER_TYPES, primaryType: 'Order', message: order }) };
}

function wrap6492(inner: Hex): Hex {
  const body = encodeAbiParameters([{ type: 'address' }, { type: 'bytes' }, { type: 'bytes' }], ['0x00000000000000000000000000000000000fac70', '0xdeadbeef', inner]);
  return (body + ERC6492_SUFFIX) as Hex;
}

describe('signature validation (mirrors the contract)', () => {
  const chain = { code: new Map<string, Hex>([[WALLET.toLowerCase(), '0x6001']]), wallets: new Map([[WALLET.toLowerCase(), eoa.address]]) };
  const client = fakeClient(chain);

  it('accepts an EOA signature over the EIP-712 order', async () => {
    const { digest, sigP } = sign();
    assert.deepEqual(await checkOrderSignature(client, eoa.address, digest, await sigP), { ok: true });
  });

  it('rejects a signature from another key', async () => {
    const { digest, sigP } = sign(other, eoa.address);
    const r = await checkOrderSignature(client, eoa.address, digest, await sigP);
    assert.equal(r.ok, false);
  });

  it('rejects a tampered order', async () => {
    const { order, sigP } = sign();
    const tampered = orderHash({ ...order, minAmountOut: 1n }, 8453, CONTRACT);
    assert.equal((await checkOrderSignature(client, eoa.address, tampered, await sigP)).ok, false);
  });

  it('rejects a signature for another chain or contract', async () => {
    const { order, sigP } = sign();
    const sig = await sigP;
    assert.equal((await checkOrderSignature(client, eoa.address, orderHash(order, 10, CONTRACT), sig)).ok, false);
    assert.equal((await checkOrderSignature(client, eoa.address, orderHash(order, 8453, WALLET), sig)).ok, false);
  });

  it('rejects the high-s twin of a valid signature (as OpenZeppelin ECDSA does)', async () => {
    const { digest, sigP } = sign();
    const sig = await sigP;
    const r = sig.slice(0, 66);
    const s = BigInt('0x' + sig.slice(66, 130));
    const v = parseInt(sig.slice(130), 16);
    const twin = (r + (N - s).toString(16).padStart(64, '0') + (v === 27 ? '1c' : '1b')) as Hex;
    assert.equal((await checkOrderSignature(client, eoa.address, digest, twin)).ok, false);
  });

  it('normalises v = 0/1 to 27/28', async () => {
    const { digest, sigP } = sign();
    const sig = await sigP;
    const v = parseInt(sig.slice(130), 16);
    const raw = (sig.slice(0, 130) + (v - 27).toString(16).padStart(2, '0')) as Hex;
    assert.equal((await checkOrderSignature(client, eoa.address, digest, raw)).ok, false);
    assert.equal((await checkOrderSignature(client, eoa.address, digest, normalizeV(raw))).ok, true);
  });

  it('accepts an ERC-1271 smart wallet via eth_call', async () => {
    const { digest, sigP } = sign(eoa, WALLET);
    assert.deepEqual(await checkOrderSignature(client, WALLET, digest, await sigP), { ok: true });
  });

  it('rejects an ERC-1271 wallet signature by a non-owner', async () => {
    const { digest, sigP } = sign(other, WALLET);
    assert.equal((await checkOrderSignature(client, WALLET, digest, await sigP)).ok, false);
  });

  it('accepts an ERC-6492-wrapped signature once the wallet is deployed (factory call ignored)', async () => {
    const { digest, sigP } = sign(eoa, WALLET);
    assert.deepEqual(await checkOrderSignature(client, WALLET, digest, wrap6492(await sigP)), { ok: true });
  });

  it('rejects an ERC-6492 signature for a counterfactual (undeployed) wallet with a plain reason', async () => {
    const { digest, sigP } = sign(eoa, UNDEPLOYED);
    const r = await checkOrderSignature(client, UNDEPLOYED, digest, wrap6492(await sigP));
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /not deployed/);
  });

  it('accepts the key of an EIP-7702 account whose code has no ERC-1271', async () => {
    const delegated = { code: new Map<string, Hex>([[eoa.address.toLowerCase(), '0xef0100000000000000000000000000000000000000beef']]), wallets: new Map<string, Address>() };
    const { digest, sigP } = sign();
    assert.deepEqual(await checkOrderSignature(fakeClient(delegated), eoa.address, digest, await sigP), { ok: true });
  });
});
