/**
 * Order intake: validation of signed orders submitted to POST /v1/orders, and offchain cancels.
 * Pure checks live in `validateOrderTerms` (unit-tested); chain checks go through `OrderChainReader`.
 */
import { getAddress, hashTypedData, isAddressEqual, type Address, type Hex } from 'viem';
import { CANCEL_TYPES, ORDER_TYPES, orderDomain, orderFromJson, isHex, type Order } from './shared/eip712.ts';
import { closedWindow, calendarCovers } from './shared/market-clock.ts';
import { MAX_LIMIT_BPS, deviationBps, impliedPerShareE8, type Side } from './shared/pricing.ts';
import type { MarketDef } from './markets.ts';
import type { SigCheck } from './signature.ts';
import { normalizeV } from './signature.ts';

/** Minimum order size, in quote units (USDC), to keep spam and dust out. */
export const MIN_ORDER_USD = 5;
export const MAX_OPEN_ORDERS_PER_MAKER = 25;

export class OrderRejected extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'OrderRejected';
    this.status = status;
  }
}

export interface MarketContext {
  def: MarketDef;
  closeE8: bigint | null;
  multiplier: bigint | null;
  pendingEffectiveAtMs: number | null;
  transfersPaused: boolean;
}

export interface TermsInput {
  order: Order;
  nowMs: number;
  guardWindowSec: bigint;
  market: MarketContext;
}

export interface Terms {
  side: Side;
  ticker: string;
  deviationBps: bigint;
}

/** Find the market an order trades, and its side. */
export function resolveMarket(order: Order, markets: MarketDef[]): { def: MarketDef; side: Side } {
  for (const def of markets) {
    if (isAddressEqual(order.tokenIn, def.quoteToken) && isAddressEqual(order.tokenOut, def.token)) return { def, side: 'buy' };
    if (isAddressEqual(order.tokenIn, def.token) && isAddressEqual(order.tokenOut, def.quoteToken)) return { def, side: 'sell' };
  }
  throw new OrderRejected('This pair is not a listed market.');
}

/** Checks that need no RPC. Throws OrderRejected with a plain-English message. */
export function validateOrderTerms({ order, nowMs, guardWindowSec, market }: TermsInput): Terms {
  const { def } = market;
  const side: Side = isAddressEqual(order.tokenIn, def.quoteToken) ? 'buy' : 'sell';

  if (!isAddressEqual(order.stockToken, def.token)) throw new OrderRejected('stockToken must be the stock side of the pair.');
  if (order.amountIn <= 0n) throw new OrderRejected('Amount must be greater than zero.');
  if (order.minAmountOut <= 0n) throw new OrderRejected('Minimum output must be greater than zero.');

  // ---- Window: only while the US market is shut, ending at or before the next opening bell.
  if (!calendarCovers(nowMs)) throw new OrderRejected('The market calendar does not cover today; ordering is disabled.', 503);
  const win = closedWindow(nowMs);
  if (!win) throw new OrderRejected('The US market is open. Orders can only be placed while it is closed.', 409);
  const nowSec = BigInt(Math.floor(nowMs / 1000));
  const startSec = BigInt(Math.floor(win.start / 1000));
  const endSec = BigInt(Math.floor(win.end / 1000));
  if (order.validUntil > endSec) throw new OrderRejected('Expiry must be at or before the next opening bell.');
  if (order.validUntil <= nowSec + 60n) throw new OrderRejected('This order would expire within a minute.');
  if (order.validAfter < startSec) throw new OrderRejected('Start time must be after the last close.');
  if (order.validAfter >= order.validUntil) throw new OrderRejected('Start time must be before expiry.');

  // ---- Corporate actions.
  if (market.transfersPaused) throw new OrderRejected(`${def.ticker} transfers are paused by the issuer.`, 409);
  if (market.multiplier === null) throw new OrderRejected(`Could not read the ${def.ticker} multiplier. Try again shortly.`, 503);
  if (order.stockMultiplier !== market.multiplier) {
    throw new OrderRejected(`The ${def.ticker} multiplier changed. Reload and sign again.`, 409);
  }
  if (market.pendingEffectiveAtMs !== null) {
    const guardEndsMs = Number(order.validUntil) * 1000 + Number(guardWindowSec) * 1000;
    if (market.pendingEffectiveAtMs <= guardEndsMs) {
      throw new OrderRejected(`A corporate action (split or dividend adjustment) is pending for ${def.ticker}. Orders are paused until it settles.`, 409);
    }
  }

  // ---- Limit sanity vs last close.
  if (market.closeE8 === null) throw new OrderRejected(`The last close for ${def.ticker} is unavailable. Try again shortly.`, 503);
  const quoteIn = side === 'buy' ? order.amountIn : order.minAmountOut;
  if (quoteIn < BigInt(MIN_ORDER_USD) * 10n ** BigInt(def.quoteDecimals)) {
    throw new OrderRejected(`Orders must be at least ${MIN_ORDER_USD} USDC.`);
  }
  const ctx = { multiplier: order.stockMultiplier, stockDecimals: def.decimals, quoteDecimals: def.quoteDecimals };
  const implied = impliedPerShareE8(side, order.amountIn, order.minAmountOut, ctx);
  const dev = deviationBps(implied, market.closeE8);
  if (dev > MAX_LIMIT_BPS || dev < -MAX_LIMIT_BPS) {
    throw new OrderRejected(`The limit is ${(Number(dev) / 100).toFixed(2)}% from the last close; the allowed range is ±${Number(MAX_LIMIT_BPS) / 100}%.`);
  }

  return { side, ticker: def.ticker, deviationBps: dev };
}

export interface OrderChainReader {
  checkSignature(maker: Address, digest: Hex, signature: Hex): Promise<SigCheck>;
  isNonceUsed(maker: Address, nonce: bigint): Promise<boolean>;
  allowance(token: Address, owner: Address, spender: Address): Promise<bigint>;
  balanceOf(token: Address, owner: Address): Promise<bigint>;
}

export interface Intake {
  hash: Hex;
  order: Order;
  signature: Hex;
  terms: Terms;
}

export interface IntakeDeps {
  chainId: number;
  contract: Address;
  markets: MarketDef[];
  marketContext(def: MarketDef): MarketContext;
  chain: OrderChainReader;
  guardWindowSec: bigint;
  openOrdersOf(maker: Address): number;
  nonceKnown(maker: Address, nonce: bigint): boolean;
  now(): number;
}

export function orderHash(order: Order, chainId: number, contract: Address): Hex {
  return hashTypedData({ domain: orderDomain(chainId, contract), types: ORDER_TYPES, primaryType: 'Order', message: order });
}

export function cancelDigest(hash: Hex, chainId: number, contract: Address): Hex {
  return hashTypedData({ domain: orderDomain(chainId, contract), types: CANCEL_TYPES, primaryType: 'CancelOrder', message: { orderHash: hash } });
}

/** Full intake pipeline for POST /v1/orders. */
export async function intakeOrder(body: unknown, deps: IntakeDeps): Promise<Intake> {
  if (typeof body !== 'object' || body === null) throw new OrderRejected('Expected a JSON body.');
  const b = body as { order?: unknown; signature?: unknown };
  let order: Order;
  try {
    order = orderFromJson(b.order);
  } catch (e) {
    throw new OrderRejected(`Malformed order: ${(e as Error).message}`);
  }
  if (!isHex(b.signature) || b.signature.length < 4) throw new OrderRejected('Malformed signature.');
  const signature = normalizeV(b.signature);
  order = { ...order, maker: getAddress(order.maker), tokenIn: getAddress(order.tokenIn), tokenOut: getAddress(order.tokenOut), stockToken: getAddress(order.stockToken) };

  const { def } = resolveMarket(order, deps.markets);
  const terms = validateOrderTerms({ order, nowMs: deps.now(), guardWindowSec: deps.guardWindowSec, market: deps.marketContext(def) });

  if (deps.openOrdersOf(order.maker) >= MAX_OPEN_ORDERS_PER_MAKER) {
    throw new OrderRejected(`At most ${MAX_OPEN_ORDERS_PER_MAKER} open orders per address.`, 429);
  }
  if (deps.nonceKnown(order.maker, order.nonce)) throw new OrderRejected('An order with this nonce already exists.', 409);

  const hash = orderHash(order, deps.chainId, deps.contract);
  const sig = await deps.chain.checkSignature(order.maker, hash, signature);
  if (!sig.ok) throw new OrderRejected(sig.reason, 401);

  if (await deps.chain.isNonceUsed(order.maker, order.nonce)) throw new OrderRejected('This nonce was already used or cancelled onchain.', 409);
  const [allowance, balance] = await Promise.all([
    deps.chain.allowance(order.tokenIn, order.maker, deps.contract),
    deps.chain.balanceOf(order.tokenIn, order.maker),
  ]);
  if (balance < order.amountIn) throw new OrderRejected('Insufficient balance for this order.', 402);
  if (allowance < order.amountIn) throw new OrderRejected('Approve the token for Lastprint first (allowance is below the order amount).', 402);

  return { hash: hash.toLowerCase() as Hex, order, signature, terms };
}
