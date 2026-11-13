/**
 * Optional Telegram bot (enabled when TELEGRAM_BOT_TOKEN is set). Two commands only:
 *   /start <maker-address>  subscribe this chat to fills/expiries of that address (public onchain info)
 *   /gap                    current gap table
 * Uses long polling; the token is never logged.
 */
import { isAddress, getAddress } from 'viem';
import { sleep } from './chain.ts';
import type { Store } from './db.ts';
import type { Bus, ExpiryEvent, FillEvent } from './events.ts';
import { gapTable } from './report.ts';
import type { SnapshotService } from './snapshot.ts';

type Log = (msg: string) => void;

interface Update {
  update_id: number;
  message?: { chat: { id: number }; text?: string };
}

export function parseCommand(text: string): { cmd: 'start'; maker: string | null } | { cmd: 'gap' } | null {
  const t = text.trim();
  const m = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(t);
  if (m) {
    const arg = m[1];
    return { cmd: 'start', maker: arg && isAddress(arg) ? getAddress(arg).toLowerCase() : null };
  }
  if (/^\/gap(?:@\w+)?$/.test(t)) return { cmd: 'gap' };
  return null;
}

export class TelegramBot {
  private offset = 0;
  private stopped = false;

  private readonly token: string;
  private readonly store: Store;
  private readonly snapshots: SnapshotService;
  private readonly publicUrl: string;
  private readonly log: Log;

  constructor(token: string, store: Store, snapshots: SnapshotService, bus: Bus, publicUrl: string, log: Log) {
    this.token = token;
    this.store = store;
    this.snapshots = snapshots;
    this.publicUrl = publicUrl;
    this.log = log;
    bus.on('fill', (e) => void this.onFill(e));
    bus.on('expired', (e) => void this.onExpiry(e));
  }

  private async api<T>(method: string, body: unknown, timeoutMs = 40_000): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const j = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description ?? res.status}`);
    return j.result;
  }

  private send(chatId: string | number, text: string): Promise<unknown> {
    return this.api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  }

  async run(): Promise<void> {
    this.log('telegram: bot polling');
    while (!this.stopped) {
      try {
        const updates = await this.api<Update[]>('getUpdates', { offset: this.offset, timeout: 30, allowed_updates: ['message'] });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u);
        }
      } catch (e) {
        this.log(`telegram: ${(e as Error).message.replace(this.token, '***')}`);
        await sleep(5000);
      }
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async handle(u: Update): Promise<void> {
    const chatId = u.message?.chat.id;
    const text = u.message?.text;
    if (chatId === undefined || !text) return;
    const c = parseCommand(text);
    if (!c) return;
    if (c.cmd === 'start') {
      if (!c.maker) {
        await this.send(chatId, `Open Lastprint and use "Notify me on Telegram" to subscribe an address: ${this.publicUrl}`);
        return;
      }
      this.store.subscribe(String(chatId), c.maker, Date.now());
      await this.send(chatId, `Subscribed to fills and expiries for ${c.maker}. Public onchain information only.`);
      return;
    }
    const snap = this.snapshots.get();
    await this.send(chatId, snap ? gapTable(snap) : 'Gap data is loading. Try again in a minute.');
  }

  private async onFill(e: FillEvent): Promise<void> {
    const subs = this.store.subscribersOf(e.maker);
    const what = e.ticker ? `${e.side ?? ''} ${e.ticker}`.trim() : 'order';
    for (const chat of subs) {
      await this.send(chat, `Filled: ${what} order ${e.orderHash.slice(0, 10)}… tx https://basescan.org/tx/${e.txHash}`).catch((err) => this.log(`telegram send: ${(err as Error).message.replace(this.token, '***')}`));
    }
  }

  private async onExpiry(e: ExpiryEvent): Promise<void> {
    for (const chat of this.store.subscribersOf(e.maker)) {
      await this.send(chat, `Expired: ${e.side} ${e.ticker} order ${e.orderHash.slice(0, 10)}… (${e.reason}).`).catch(() => {});
    }
  }
}
