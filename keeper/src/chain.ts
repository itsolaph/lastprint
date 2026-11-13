import { createPublicClient, http, type PublicClient } from 'viem';
import { base } from 'viem/chains';
import type { Config } from './config.ts';

/**
 * Read client with retry/backoff. viem's http transport retries 429 and 5xx with exponential backoff
 * (retryDelay * 2^attempt). Multicall batching keeps the number of RPC requests low.
 */
export function makePublicClient(cfg: Pick<Config, 'rpcUrl'>): PublicClient {
  return createPublicClient({
    chain: base,
    transport: http(cfg.rpcUrl, {
      retryCount: 5,
      retryDelay: 400,
      timeout: 20_000,
      batch: false,
    }),
    batch: { multicall: { wait: 16 } },
  }) as PublicClient;
}

/** True for HTTP 429 / rate-limit errors, so loops can back off further than the transport does. */
export function isRateLimit(err: unknown): boolean {
  const s = String((err as { details?: string; message?: string })?.details ?? (err as Error)?.message ?? err);
  return /429|rate.?limit|too many requests/i.test(s);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
