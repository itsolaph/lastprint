/**
 * Indexes LastprintOrders events from the deploy block, in small ranges, tolerating RPC rate limits.
 * Filled events are the source of truth for fills and stats; cancel events close orders in the DB.
 */
import type { Address, PublicClient } from 'viem';
import { lastprintAbi } from './abis.ts';
import { isRateLimit, sleep } from './chain.ts';
import type { Store } from './db.ts';
import type { Bus } from './events.ts';

const CURSOR_KEY = 'indexer.lastBlock';
/** Stay a few blocks behind head; Base reorgs are rare and shallow. */
const CONFIRMATIONS = 3n;

type Log = (msg: string) => void;

export class Indexer {
  private stopped = false;
  private range: bigint;
  private readonly client: PublicClient;
  private readonly store: Store;
  private readonly bus: Bus;
  private readonly contract: Address;
  private readonly deployBlock: bigint;
  private readonly maxRange: bigint;
  private readonly log: Log;

  constructor(client: PublicClient, store: Store, bus: Bus, contract: Address, deployBlock: bigint, maxRange: bigint, log: Log) {
    this.client = client;
    this.store = store;
    this.bus = bus;
    this.contract = contract;
    this.deployBlock = deployBlock;
    this.maxRange = maxRange;
    this.log = log;
    this.range = maxRange;
  }

  get cursor(): bigint {
    const v = this.store.getMeta(CURSOR_KEY);
    return v ? BigInt(v) : this.deployBlock - 1n;
  }

  async run(): Promise<void> {
    let backoff = 0;
    while (!this.stopped) {
      try {
        const caughtUp = await this.step();
        backoff = 0;
        if (caughtUp) await sleep(4000);
      } catch (e) {
        if (isRateLimit(e)) {
          this.range = this.range > 50n ? this.range / 2n : this.range;
          backoff = Math.min(Math.max(backoff * 2, 5000), 120_000);
          this.log(`indexer: rate limited; range ${this.range}, waiting ${backoff / 1000}s`);
        } else {
          backoff = Math.min(Math.max(backoff * 2, 3000), 60_000);
          this.log(`indexer: ${(e as Error).message}`);
        }
        await sleep(backoff);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  /** Index one range. Returns true when caught up with head. */
  async step(): Promise<boolean> {
    const head = (await this.client.getBlockNumber()) - CONFIRMATIONS;
    const from = this.cursor + 1n;
    if (from > head) return true;
    const to = from + this.range - 1n < head ? from + this.range - 1n : head;

    const logs = await this.client.getContractEvents({ address: this.contract, abi: lastprintAbi, fromBlock: from, toBlock: to });
    const now = Date.now();
    for (const l of logs) {
      if (l.eventName === 'Filled') {
        const a = l.args;
        const orderHash = a.orderHash!.toLowerCase();
        const inserted = this.store.insertFill({
          tx_hash: l.transactionHash!,
          log_index: l.logIndex!,
          order_hash: orderHash,
          maker: a.maker!.toLowerCase(),
          token_in: a.tokenIn!.toLowerCase(),
          token_out: a.tokenOut!.toLowerCase(),
          amount_in: a.amountIn!.toString(),
          amount_out: a.amountOut!.toString(),
          filler: a.filler!.toLowerCase(),
          block_number: Number(l.blockNumber),
        });
        const order = this.store.getOrder(orderHash);
        if (order) this.store.setStatus(orderHash, 'filled', now, { fill_tx: l.transactionHash!, amount_out: a.amountOut!.toString() });
        if (inserted) {
          this.bus.emit('fill', {
            orderHash,
            maker: a.maker!.toLowerCase(),
            ticker: order?.ticker ?? null,
            side: order?.side ?? null,
            tokenIn: a.tokenIn!,
            tokenOut: a.tokenOut!,
            amountIn: a.amountIn!.toString(),
            amountOut: a.amountOut!.toString(),
            filler: a.filler!,
            txHash: l.transactionHash!,
            blockNumber: Number(l.blockNumber),
          });
        }
      } else if (l.eventName === 'NonceCancelled') {
        const o = this.store.orderByMakerNonce(l.args.maker!, l.args.nonce!);
        if (o && (o.status === 'open' || o.status === 'filling')) this.store.setStatus(o.hash, 'cancelled', now, { last_error: 'cancelled onchain' });
      } else if (l.eventName === 'NoncesCancelledUpTo') {
        this.store.cancelBelow(l.args.maker!, l.args.minNonce!, now);
      }
    }
    this.store.setMeta(CURSOR_KEY, to.toString());
    if (this.range < this.maxRange) this.range = this.range * 2n > this.maxRange ? this.maxRange : this.range * 2n;
    return to >= head;
  }
}
