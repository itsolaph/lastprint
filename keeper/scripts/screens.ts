/**
 * Screenshot the running web app (landing + app on one page) and fail on horizontal overflow.
 *   node scripts/screens.ts [--url http://127.0.0.1:18797] [--out <dir>] [--sections <dir>]
 *
 * Saved to --out (default docs/screens):
 *   v3-hero-1440x900     the first viewport, as served
 *   v3-full-1440 / -390  the full page, as served, live data
 *   v3-ticket-1440/-390  the #app section. Demo: an injected mock wallet and mocked order list (no real wallet, no
 *                        transactions), browser clock set to a New York night so the ticket is in its "approve" step
 *   v3-open-1440         the full page with the browser clock set inside a US session (ordering paused)
 *   gap-report-1200x675  the /report card
 *
 * --sections <dir> also saves one crop per page section at both widths, for close review.
 */
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { BrowserContext, Page } from 'playwright-core';
import { launch } from './browser.ts';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:18797' },
    out: { type: 'string', default: fileURLToPath(new URL('../../docs/screens', import.meta.url)) },
    sections: { type: 'string' },
  },
});
const url = values.url!;
const out = resolve(values.out!);
const sectionsDir = values.sections ? resolve(values.sections) : null;
mkdirSync(out, { recursive: true });
if (sectionsDir) mkdirSync(sectionsDir, { recursive: true });

const PUBLIC_IMG = fileURLToPath(new URL('../public/img/', import.meta.url));
const IMG_TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };

const DEMO_MAKER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** Browser clocks for the demo states: Thursday night in New York (market shut), and inside Friday's session. */
const CLOSED_AT = '2026-11-13T03:00:00Z';
const OPEN_AT = '2026-11-13T16:05:00Z';

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

/** Demo order list for the mock wallet. The instance's own /v1/config is used as served. */
async function demoRoutes(page: Page): Promise<void> {
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

/**
 * A keeper process started before .jpg/.webp/.mp4 were added to its static types answers 404 for /img/*.
 * In that case the photographs are read from keeper/public/img on disk so the page can still be reviewed.
 */
let imagesFromDisk: boolean | null = null;
async function imageFallback(ctx: BrowserContext): Promise<void> {
  if (imagesFromDisk === null) {
    const probe = await fetch(`${url}/img/hero.jpg`).catch(() => null);
    imagesFromDisk = !probe?.ok;
    if (imagesFromDisk) console.warn(`NOTE: ${url}/img/hero.jpg is not served by the running process (restart it to pick up the new static types). Photographs in these screenshots are read from keeper/public/img on disk.`);
  }
  if (!imagesFromDisk) return;
  await ctx.route('**/img/*', async (route) => {
    const name = basename(new URL(route.request().url()).pathname);
    const contentType = IMG_TYPES[extname(name)];
    try {
      if (!contentType) throw new Error('unknown type');
      await route.fulfill({ body: await readFile(join(PUBLIC_IMG, name)), contentType });
    } catch {
      await route.continue();
    }
  });
}

async function open(ctx: BrowserContext, prepare?: (page: Page) => Promise<void>): Promise<Page> {
  await imageFallback(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.warn(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.warn(`console error: ${m.text()}`);
  });
  if (prepare) await prepare(page);
  await page.goto(url, { waitUntil: 'networkidle' });
  // Real data on the tape and the board before anything is shot.
  await page.waitForSelector('#tape-track .print .t');
  await page.waitForSelector('#markets-body .pick');
  return page;
}

/** Walk the page once so sections reveal, lazy photographs load and the stats count up; then return to the top. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const step = Math.round(window.innerHeight * 0.7);
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => setTimeout(r, 150));
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0), undefined, { timeout: 15_000 });
  await page.waitForTimeout(1600);
}

async function assertNoOverflow(page: Page, name: string): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  if (scrollWidth !== clientWidth) throw new Error(`${name}: horizontal overflow (scrollWidth ${scrollWidth} != clientWidth ${clientWidth})`);
}

async function shootFull(page: Page, name: string): Promise<void> {
  await assertNoOverflow(page, name);
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  console.log(`saved ${file} (scrollWidth == clientWidth)`);
}

/** One section, cut out of the full page as it lies at scroll position 0 (so the fixed nav never covers it). */
async function shootSection(page: Page, selector: string, file: string): Promise<void> {
  const clip = await page.evaluate((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect();
    return { x: 0, y: Math.round(r.top + window.scrollY), width: document.documentElement.clientWidth, height: Math.round(r.height) };
  }, selector);
  await page.screenshot({ path: file, fullPage: true, clip, animations: 'disabled' });
}

async function shootSections(page: Page, width: number, label: string): Promise<void> {
  if (!sectionsDir) return;
  for (const sel of ['#top', '#how', '#markets', '#app', '#proof', '#faq', 'footer.foot']) {
    await shootSection(page, sel, join(sectionsDir, `${label}-${width}-${sel.replace(/[^a-z]/g, '')}.png`));
  }
  console.log(`saved section crops (${label}, ${width}px) to ${sectionsDir}`);
}

const browser = await launch();
try {
  // First viewport at 1440x900.
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    const page = await open(ctx);
    await page.waitForTimeout(1500);
    await assertNoOverflow(page, 'v3-hero-1440x900');
    const file = join(out, 'v3-hero-1440x900.png');
    await page.screenshot({ path: file, animations: 'disabled' });
    console.log(`saved ${file}`);
    console.log(`hero video: ${await page.evaluate(() => { const v = document.querySelector('#hero-video'); return v ? (v.classList.contains('is-playing') ? 'playing over the still' : 'present, not playing') : 'removed (could not load, or reduced motion)'; })}`);
    await ctx.close();
  }

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    // As served, live data.
    {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
      const page = await open(ctx);
      await settle(page);
      await shootFull(page, `v3-full-${width}`);
      await shootSections(page, width, 'served');
      await ctx.close();
    }
    // Demo wallet: the ticket in its "approve" step, with orders listed.
    {
      const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
      await ctx.addInitScript(MOCK_WALLET);
      const page = await open(ctx, async (p) => {
        await p.clock.install({ time: new Date(CLOSED_AT) });
        await demoRoutes(p);
      });
      await page.fill('#f-amount', '1000');
      await page.fill('#f-limit', '-1.50');
      await settle(page);
      await assertNoOverflow(page, `v3-ticket-${width}`);
      const file = join(out, `v3-ticket-${width}.png`);
      await shootSection(page, '#app', file);
      console.log(`saved ${file}`);
      await ctx.close();
    }
  }

  // Market open (browser clock moved into Friday's session).
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
    const page = await open(ctx, async (p) => {
      await p.clock.install({ time: new Date(OPEN_AT) });
      await demoRoutes(p);
    });
    await settle(page);
    await shootFull(page, 'v3-open-1440');
    await shootSections(page, 1440, 'open');
    await ctx.close();
  }

  // Review-only states: first paint before any data, keyboard focus, row hover, an open FAQ answer.
  if (sectionsDir) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await imageFallback(ctx);
    const page = await ctx.newPage();
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/v1\/(markets|stats)$/, async (route) => {
      await held;
      await route.continue();
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(sectionsDir, 'skeleton-1440-top.png') });
    await shootSection(page, '#markets', join(sectionsDir, 'skeleton-1440-markets.png'));
    await shootSection(page, '#proof', join(sectionsDir, 'skeleton-1440-proof.png'));
    release();
    await page.waitForSelector('#markets-body .pick');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.screenshot({ path: join(sectionsDir, 'focus-1440-nav.png'), clip: { x: 0, y: 0, width: 1440, height: 120 } });
    await page.focus('.hero-actions .btn.ghost');
    await page.keyboard.press('Shift+Tab');
    await page.screenshot({ path: join(sectionsDir, 'focus-1440-hero.png'), clip: { x: 0, y: 500, width: 760, height: 180 } });
    await page.click('#faq details:nth-of-type(2) summary');
    await page.waitForTimeout(300);
    await shootSection(page, '#faq', join(sectionsDir, 'open-1440-faq.png'));
    await page.locator('#markets').scrollIntoViewIfNeeded();
    await page.focus('#markets-body tr[data-ticker="GOOGL"] .pick');
    await page.hover('#markets-body tr[data-ticker="AMZN"] td.base');
    await page.screenshot({ path: join(sectionsDir, 'hover-1440-markets.png') });
    await ctx.close();
  }

  // Mobile menu open, and reduced motion (tape static, no reveals, no video).
  if (sectionsDir) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await open(ctx);
    await page.click('#nav-toggle');
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(sectionsDir, 'menu-390.png'), animations: 'disabled' });
    await page.click('#nav-toggle');
    await page.mouse.move(200, 600);
    await page.click('#faq details:first-of-type summary');
    await settle(page);
    await assertNoOverflow(page, 'reduced-motion-390');
    await page.screenshot({ path: join(sectionsDir, 'reduced-390.png'), fullPage: true });
    console.log(`saved menu and reduced-motion shots to ${sectionsDir}`);
    await ctx.close();
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
