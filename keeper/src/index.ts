/**
 * Lastprint keeper: API + static web app + keeper loop + event indexer + optional Telegram bot.
 *   node src/index.ts      (reads env; see .env.example)
 */
import { serve } from '@hono/node-server';
import type { Address, Hex } from 'viem';
import { erc20Abi, lastprintAbi } from './abis.ts';
import { makePublicClient, sleep } from './chain.ts';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { Bus } from './events.ts';
import { Indexer } from './indexer.ts';
import { Keeper } from './keeper.ts';
import { LastCloseService } from './lastclose.ts';
import { loadMarkets, type MarketDef } from './markets.ts';
import type { MarketContext, OrderChainReader } from './orders.ts';
import { createApp } from './server.ts';
import { checkOrderSignature } from './signature.ts';
import { SnapshotService } from './snapshot.ts';
import { TelegramBot } from './telegram.ts';

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = new Store(cfg.dbPath);
  const client = makePublicClient(cfg);
  const bus = new Bus();
  const { markets } = loadMarkets(cfg.marketsPath);
  log(`loaded ${markets.length} markets`);

  // A crash mid-fill can leave orders in 'filling'; the onchain nonce makes a retry safe.
  for (const o of store.ordersByStatus('filling')) store.backoff(o.hash, Date.now(), 0, 'recovered after restart');

  const closes = new LastCloseService(store, undefined, log);
  const snapshots = new SnapshotService(client, cfg, markets, closes, log);

  const checkSignature = (maker: Address, digest: Hex, sig: Hex) => checkOrderSignature(client, maker, digest, sig);

  let guardWindowSec = 86_400n;
  if (cfg.lastprintAddress) {
    try {
      guardWindowSec = await client.readContract({ address: cfg.lastprintAddress, abi: lastprintAbi, functionName: 'guardWindow' });
    } catch (e) {
      log(`could not read guardWindow from ${cfg.lastprintAddress}: ${(e as Error).message}`);
    }
  }

  const contextFor = (def: MarketDef): MarketContext => {
    const m = snapshots.get()?.markets.find((x) => x.ticker === def.ticker);
    return {
      def,
      closeE8: m?.lastClose ? BigInt(m.lastClose.closeE8) : null,
      multiplier: m?.multiplier ? BigInt(m.multiplier) : null,
      pendingEffectiveAtMs: m?.pendingAction?.effectiveAt ?? null,
      transfersPaused: m?.transfersPaused ?? false,
    };
  };

  const chainReader: OrderChainReader = {
    checkSignature,
    isNonceUsed: (maker, nonce) => client.readContract({ address: cfg.lastprintAddress!, abi: lastprintAbi, functionName: 'isNonceUsed', args: [maker, nonce] }),
    allowance: (token, owner, spender) => client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }),
    balanceOf: (token, owner) => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }),
  };

  const keeperMode = !cfg.lastprintAddress ? 'off' : cfg.keeperPrivateKey ? 'send' : 'watch';
  const app = createApp({
    cfg,
    store,
    bus,
    snapshots,
    checkSignature,
    keeperMode,
    telegramBot: cfg.telegramBotToken ? cfg.telegramBotUsername : null,
    intake: cfg.lastprintAddress
      ? {
          chainId: cfg.chainId,
          contract: cfg.lastprintAddress,
          markets,
          marketContext: contextFor,
          chain: chainReader,
          guardWindowSec,
          openOrdersOf: (maker) => store.ordersByMaker(maker.toLowerCase(), 1000).filter((o) => o.status === 'open' || o.status === 'filling').length,
          nonceKnown: (maker, nonce) => store.orderByMakerNonce(maker, nonce) !== null,
        }
      : null,
  });

  serve({ fetch: app.fetch, hostname: cfg.host, port: cfg.port }, (info) => {
    log(`listening on http://${info.address}:${info.port}${cfg.lastprintAddress ? '' : ' (read-only: LASTPRINT_ADDRESS not set)'}`);
  });

  // Snapshot refresher (markets, closes, quotes).
  void (async () => {
    for (;;) {
      try {
        await snapshots.refresh();
      } catch (e) {
        log(`snapshot refresh failed: ${(e as Error).message}`);
      }
      await sleep(15_000);
    }
  })();

  if (cfg.lastprintAddress) {
    const keeper = new Keeper(client, cfg, store, markets, bus, log);
    keeper.guardWindowSec = Number(guardWindowSec);
    void keeper.run();
    const indexer = new Indexer(client, store, bus, cfg.lastprintAddress, cfg.deployBlock, cfg.logRangeBlocks, log);
    void indexer.run();
  }

  if (cfg.telegramBotToken) {
    const bot = new TelegramBot(cfg.telegramBotToken, store, snapshots, bus, cfg.publicUrl, log);
    void bot.run();
  }
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
