/**
 * Screenshot the running web app at 1440 and 390 px and fail on horizontal overflow.
 *   node scripts/screens.ts [--url http://127.0.0.1:18797] [--out ../docs/screens]
 *
 * States captured:
 *   readonly-*   the instance as served (no contract configured -> ordering off), live data
 *   ticket-*     demo: a mocked contract address and an injected mock wallet (no real wallet, no transactions)
 *   open-*       demo: browser clock set inside a US session (tape frozen, ordering paused)
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Page } from 'playwright-core';
import { launch } from './browser.ts';

const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:18797' }, out: { type: 'string', default: '../docs/screens' } } });
const url = values.url!;
const out = resolve(values.out!);
mkdirSync(out, { recursive: true });

const DEMO_CONTRACT = '0x000000000000000000000000000000000000dEaD';
const DEMO_MAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

/** Minimal EIP-1193 mock: Base, one account, 2,500 USDC / 12 tokens balance, zero allowance. */
const MOCK_WALLET = `
  (() => {
    const pad = (h) => '0x' + h.padStart(64, '0');
    window.ethereum = {
      isMock: true,
      on() {}, removeListener() {},
      async request({ method, params }) {
        if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['${DEMO_MAKER}'];
        if (method === 'eth_chainId') return '0x2105';
        if (method === 'eth_call') {
          const { to, data } = params[0];
          const sel = data.slice(0, 10);
          const usdc = to.toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
          if (sel === '0x70a08231') return pad((usdc ? 2500n * 10n ** 6n : 12n * 10n ** 8n).toString(16));
          if (sel === '0xdd62ed3e') return pad('0');
          return pad('0');
        }
        throw Object.assign(new Error('mock wallet: ' + method), { code: 4200 });
      },
    };
  })();
`;

async function demoRoutes(page: Page): Promise<void> {
  await page.route('**/v1/config', async (route) => {
    const res = await route.fetch();
    const cfg = await res.json();
    await route.fulfill({ json: { ...cfg, contract: DEMO_CONTRACT, orderingEnabled: true, keeperMode: 'watch', telegramBot: 'LastprintBot' } });
  });
  await page.route('**/v1/orders?maker=*', (route) =>
    route.fulfill({
      json: {
        orders: [
          { hash: '0x' + '1'.repeat(64), maker: DEMO_MAKER.toLowerCase(), ticker: 'NVDA', side: 'buy', tokenIn: '', tokenOut: '', amountIn: '500000000', minAmountOut: '303000000', stockMultiplier: '1', validUntil: 1794580200, nonce: '1', status: 'open', createdAt: 0, fillTx: null, amountOut: null, note: null },
          { hash: '0x' + '2'.repeat(64), maker: DEMO_MAKER.toLowerCase(), ticker: 'TSLA', side: 'sell', tokenIn: '', tokenOut: '', amountIn: '100000000', minAmountOut: '399000000', stockMultiplier: '1', validUntil: 1794321000, nonce: '2', status: 'filled', createdAt: 0, fillTx: '0x' + 'a'.repeat(64), amountOut: '400310000', note: null },
          { hash: '0x' + '3'.repeat(64), maker: DEMO_MAKER.toLowerCase(), ticker: 'AAPL', side: 'buy', tokenIn: '', tokenOut: '', amountIn: '250000000', minAmountOut: '71000000', stockMultiplier: '1', validUntil: 1794234600, nonce: '3', status: 'expired', createdAt: 0, fillTx: null, amountOut: null, note: 'reached next opening bell' },
        ],
      },
    }),
  );
}

async function shoot(page: Page, name: string, width: number): Promise<void> {
  await page.setViewportSize({ width, height: width > 600 ? 1000 : 900 });
  await page.waitForTimeout(400);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 0) throw new Error(`${name}: horizontal overflow of ${overflow}px at ${width}px`);
  const file = join(out, `${name}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  console.log(`saved ${file} (no horizontal overflow)`);
}

const browser = await launch();
try {
  for (const width of [1440, 390]) {
    // 1. As served.
    {
      const ctx = await browser.newContext({ deviceScaleFactor: 1, reducedMotion: 'no-preference' });
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector('#markets-body .pick');
      await shoot(page, 'readonly', width);
      await ctx.close();
    }
    // 2. Demo wallet + configured contract: the ticket in its "approve" step.
    {
      const ctx = await browser.newContext({ deviceScaleFactor: 1 });
      await ctx.addInitScript(MOCK_WALLET);
      const page = await ctx.newPage();
      await demoRoutes(page);
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector('#markets-body .pick');
      await page.fill('#f-amount', '1000');
      await page.fill('#f-limit', '-1.50');
      await page.waitForTimeout(800);
      await shoot(page, 'ticket', width);
      await ctx.close();
    }
    // 3. Market open (browser clock moved into Friday's session).
    {
      const ctx = await browser.newContext({ deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      await page.clock.install({ time: new Date('2026-11-13T16:05:00Z') });
      await demoRoutes(page);
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForSelector('#markets-body .pick');
      await shoot(page, 'open', width);
      await ctx.close();
    }
  }
  // Report card.
  {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 675 } });
    const page = await ctx.newPage();
    await page.goto(`${url}/report`, { waitUntil: 'networkidle' });
    await page.waitForSelector('body[data-ready="1"]');
    const file = join(out, 'gap-report-1200x675.png');
    await page.screenshot({ path: file });
    console.log(`saved ${file}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
