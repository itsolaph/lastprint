/**
 * Integer price math shared by the keeper and the web app.
 *
 * Units
 *   closeE8      official close, USD per share, scaled 1e8 (166.19 -> 16_619_000_000n)
 *   multiplier   B20 UI multiplier, WAD (1e18 = 1.0). shares = rawTokens * multiplier / 1e18
 *   bps          limit vs last close in basis points (-200 = 2% below the close)
 *   quote token  USDC-like, `quoteDecimals` (6)
 *   stock token  B20, `stockDecimals` (8 for NVDAc)
 *
 * Token price per whole token = close * multiplier. Rounding always favours the maker: the signed
 * `minAmountOut` is rounded UP, so the effective execution price is never worse than the limit.
 */

export const WAD = 10n ** 18n;
export const E8 = 10n ** 8n;
export const BPS = 10_000n;

/** Accepted limit range relative to the last close. Wider limits are rejected as likely mistakes. */
export const MAX_LIMIT_BPS = 3_000n; // +-30%

export type Side = 'buy' | 'sell';

export interface PriceContext {
  closeE8: bigint;
  multiplier: bigint;
  stockDecimals: number;
  quoteDecimals: number;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('division by non-positive');
  if (a < 0n) throw new Error('negative numerator');
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

/** Parse a decimal string ("166.19") into an integer scaled by 10^decimals, truncating extra digits. */
export function parseDecimal(value: string, decimals: number): bigint {
  const s = value.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not a positive decimal: ${value}`);
  const [int, frac = ''] = s.split('.') as [string, string?];
  const f = (frac ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(int) * pow10(decimals) + BigInt(f || '0');
}

/** Format an integer scaled by 10^decimals with exactly `shown` fraction digits (truncated). */
export function formatFixed(value: bigint, decimals: number, shown = decimals): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = pow10(decimals);
  const int = v / base;
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, shown);
  const intStr = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (shown > 0 ? `${intStr}.${frac}` : intStr);
}

/** Limit price per share (E8) from the last close and a bps offset. */
export function limitPerShareE8(closeE8: bigint, bps: bigint): bigint {
  return (closeE8 * (BPS + bps)) / BPS;
}

/**
 * Minimum output for an order with input `amountIn` whose limit is `bps` from the last close.
 * buy  : amountIn is quote (USDC) raw, output is stock raw.
 * sell : amountIn is stock raw, output is quote raw.
 */
export function minAmountOutFor(side: Side, amountIn: bigint, bps: bigint, ctx: PriceContext): bigint {
  if (amountIn <= 0n) throw new Error('amountIn must be positive');
  if (bps <= -BPS) throw new Error('limit must be above zero');
  if (ctx.closeE8 <= 0n || ctx.multiplier <= 0n) throw new Error('bad price context');
  const sd = pow10(ctx.stockDecimals);
  const qd = pow10(ctx.quoteDecimals);
  const priceNum = ctx.closeE8 * (BPS + bps) * ctx.multiplier; // USD per token * 1e8 * 1e4 * 1e18
  const priceDen = E8 * BPS * WAD;
  if (side === 'buy') {
    // tokens = usd / price
    return ceilDiv(amountIn * sd * priceDen, priceNum * qd);
  }
  // usd = tokens * price
  return ceilDiv(amountIn * priceNum * qd, sd * priceDen);
}

/** Effective price per share (E8) implied by an (amountIn, amountOut) pair. */
export function impliedPerShareE8(side: Side, amountIn: bigint, amountOut: bigint, ctx: Omit<PriceContext, 'closeE8'>): bigint {
  const sd = pow10(ctx.stockDecimals);
  const qd = pow10(ctx.quoteDecimals);
  if (amountIn <= 0n || amountOut <= 0n) return 0n;
  // per-token price E8 = usd * 1e8 / tokens; per-share = per-token * 1e18 / multiplier
  if (side === 'buy') return (amountIn * sd * E8 * WAD) / (amountOut * qd * ctx.multiplier);
  return (amountOut * sd * E8 * WAD) / (amountIn * qd * ctx.multiplier);
}

/** (implied / close - 1) in bps, rounded toward zero. */
export function deviationBps(perShareE8: bigint, closeE8: bigint): bigint {
  if (closeE8 <= 0n) throw new Error('bad close');
  return ((perShareE8 - closeE8) * BPS) / closeE8;
}

/**
 * Whether a quoted output clears the order's minimum with a safety margin, all integers:
 * quote >= minOut * (1 + safetyBps / 1e4), rounded up.
 */
export function clearsWithMargin(quoteOut: bigint, minOut: bigint, safetyBps: bigint): boolean {
  return quoteOut >= ceilDiv(minOut * (BPS + safetyBps), BPS);
}

/**
 * Mid price of the stock token in quote units (USDC per whole token) from a CL pool's sqrtPriceX96.
 * sqrtPriceX96^2 / 2^192 = raw token1 per raw token0. Float, for display and gap only.
 */
export function stockMidFromSqrtX96(sqrtPriceX96: bigint, stockIsToken0: boolean, stockDecimals: number, quoteDecimals: number): number {
  const sp = Number(sqrtPriceX96) / 2 ** 96;
  const raw1Per0 = sp * sp;
  if (raw1Per0 === 0) return 0;
  if (stockIsToken0) {
    // token1 = quote: quote per stock = raw1Per0 * 10^(d0 - d1)
    return raw1Per0 * 10 ** (stockDecimals - quoteDecimals);
  }
  // token0 = quote, token1 = stock: stock per quote (human) = raw1Per0 * 10^(dq - ds)
  return 1 / (raw1Per0 * 10 ** (quoteDecimals - stockDecimals));
}

/** Gap of a Base per-share price vs the last close, as a fraction (-0.0095 = -0.95%). */
export function gapFraction(basePerShare: number, close: number): number {
  return close > 0 ? basePerShare / close - 1 : 0;
}
