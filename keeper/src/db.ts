import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type OrderStatus = 'open' | 'filling' | 'filled' | 'expired' | 'cancelled';

export interface OrderRow {
  hash: string;
  maker: string;
  ticker: string;
  side: 'buy' | 'sell';
  token_in: string;
  token_out: string;
  amount_in: string;
  min_amount_out: string;
  stock_token: string;
  stock_multiplier: string;
  valid_after: number;
  valid_until: number;
  nonce: string;
  signature: string;
  status: OrderStatus;
  created_at: number;
  updated_at: number;
  fill_tx: string | null;
  amount_out: string | null;
  last_error: string | null;
  attempts: number;
  next_attempt_at: number;
  expiry_notified: number;
}

export interface CloseRow {
  ticker: string;
  session_date: string;
  close_e8: string;
  source: string;
  fetched_at: number;
  final: number;
}

export interface FillRow {
  tx_hash: string;
  log_index: number;
  order_hash: string;
  maker: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  amount_out: string;
  filler: string;
  block_number: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orders (
  hash TEXT PRIMARY KEY,
  maker TEXT NOT NULL,
  ticker TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy','sell')),
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  min_amount_out TEXT NOT NULL,
  stock_token TEXT NOT NULL,
  stock_multiplier TEXT NOT NULL,
  valid_after INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','filling','filled','expired','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  fill_tx TEXT,
  amount_out TEXT,
  last_error TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  expiry_notified INTEGER NOT NULL DEFAULT 0,
  UNIQUE (maker, nonce)
);
CREATE INDEX IF NOT EXISTS orders_maker ON orders (maker);
CREATE INDEX IF NOT EXISTS orders_status ON orders (status);

CREATE TABLE IF NOT EXISTS closes (
  ticker TEXT NOT NULL,
  session_date TEXT NOT NULL,
  close_e8 TEXT NOT NULL,
  source TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  final INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ticker, session_date)
);

CREATE TABLE IF NOT EXISTS fills (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  order_hash TEXT NOT NULL,
  maker TEXT NOT NULL,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  filler TEXT NOT NULL,
  block_number INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS fills_order ON fills (order_hash);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tg_subs (
  chat_id TEXT NOT NULL,
  maker TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, maker)
);
`;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------- meta
  getMeta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ---------------------------------------------------------------- closes
  getClose(ticker: string, sessionDate: string): CloseRow | null {
    return (this.db.prepare('SELECT * FROM closes WHERE ticker = ? AND session_date = ?').get(ticker, sessionDate) as CloseRow | undefined) ?? null;
  }

  putClose(r: CloseRow): void {
    this.db
      .prepare(
        `INSERT INTO closes (ticker, session_date, close_e8, source, fetched_at, final) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(ticker, session_date) DO UPDATE SET close_e8 = excluded.close_e8, source = excluded.source,
           fetched_at = excluded.fetched_at, final = excluded.final`,
      )
      .run(r.ticker, r.session_date, r.close_e8, r.source, r.fetched_at, r.final);
  }

  // ---------------------------------------------------------------- orders
  insertOrder(r: Omit<OrderRow, 'fill_tx' | 'amount_out' | 'last_error' | 'attempts' | 'next_attempt_at' | 'expiry_notified'>): void {
    this.db
      .prepare(
        `INSERT INTO orders (hash, maker, ticker, side, token_in, token_out, amount_in, min_amount_out, stock_token,
           stock_multiplier, valid_after, valid_until, nonce, signature, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.hash, r.maker, r.ticker, r.side, r.token_in, r.token_out, r.amount_in, r.min_amount_out, r.stock_token,
        r.stock_multiplier, r.valid_after, r.valid_until, r.nonce, r.signature, r.status, r.created_at, r.updated_at,
      );
  }

  getOrder(hash: string): OrderRow | null {
    return (this.db.prepare('SELECT * FROM orders WHERE hash = ?').get(hash.toLowerCase()) as OrderRow | undefined) ?? null;
  }

  ordersByMaker(maker: string, limit = 100): OrderRow[] {
    return this.db.prepare('SELECT * FROM orders WHERE maker = ? ORDER BY created_at DESC LIMIT ?').all(maker.toLowerCase(), limit) as unknown as OrderRow[];
  }

  ordersByStatus(...statuses: OrderStatus[]): OrderRow[] {
    const q = `SELECT * FROM orders WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY created_at ASC`;
    return this.db.prepare(q).all(...statuses) as unknown as OrderRow[];
  }

  setStatus(hash: string, status: OrderStatus, now: number, extra: { fill_tx?: string | null; amount_out?: string | null; last_error?: string | null } = {}): void {
    this.db
      .prepare(
        `UPDATE orders SET status = ?, updated_at = ?,
           fill_tx = COALESCE(?, fill_tx), amount_out = COALESCE(?, amount_out), last_error = ?
         WHERE hash = ?`,
      )
      .run(status, now, extra.fill_tx ?? null, extra.amount_out ?? null, extra.last_error ?? null, hash);
  }

  /** Atomically move open -> filling. Returns false if another worker already claimed it. */
  claimForFill(hash: string, now: number): boolean {
    const r = this.db.prepare("UPDATE orders SET status = 'filling', updated_at = ?, attempts = attempts + 1 WHERE hash = ? AND status = 'open'").run(now, hash);
    return Number(r.changes) === 1;
  }

  backoff(hash: string, now: number, delayMs: number, error: string): void {
    this.db
      .prepare("UPDATE orders SET status = CASE WHEN status = 'filling' THEN 'open' ELSE status END, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE hash = ?")
      .run(now + delayMs, error.slice(0, 500), now, hash);
  }

  markExpiryNotified(hash: string): void {
    this.db.prepare('UPDATE orders SET expiry_notified = 1 WHERE hash = ?').run(hash);
  }

  /** Mark every not-yet-final order of `maker` with nonce < minNonce as cancelled (onchain cancelUpTo). */
  cancelBelow(maker: string, minNonce: bigint, now: number): string[] {
    const rows = this.db.prepare("SELECT hash, nonce FROM orders WHERE maker = ? AND status IN ('open','filling')").all(maker.toLowerCase()) as { hash: string; nonce: string }[];
    const hit = rows.filter((r) => BigInt(r.nonce) < minNonce).map((r) => r.hash);
    for (const h of hit) this.setStatus(h, 'cancelled', now, { last_error: 'cancelled onchain (cancelUpTo)' });
    return hit;
  }

  orderByMakerNonce(maker: string, nonce: bigint): OrderRow | null {
    return (this.db.prepare('SELECT * FROM orders WHERE maker = ? AND nonce = ?').get(maker.toLowerCase(), nonce.toString()) as OrderRow | undefined) ?? null;
  }

  // ---------------------------------------------------------------- fills
  insertFill(f: FillRow): boolean {
    const r = this.db
      .prepare(
        `INSERT OR IGNORE INTO fills (tx_hash, log_index, order_hash, maker, token_in, token_out, amount_in, amount_out, filler, block_number)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(f.tx_hash, f.log_index, f.order_hash, f.maker, f.token_in, f.token_out, f.amount_in, f.amount_out, f.filler, f.block_number);
    return Number(r.changes) === 1;
  }

  allFills(): FillRow[] {
    return this.db.prepare('SELECT * FROM fills ORDER BY block_number ASC, log_index ASC').all() as unknown as FillRow[];
  }

  countOrders(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n);
  }

  // ---------------------------------------------------------------- telegram
  subscribe(chatId: string, maker: string, now: number): void {
    this.db.prepare('INSERT OR IGNORE INTO tg_subs (chat_id, maker, created_at) VALUES (?, ?, ?)').run(chatId, maker.toLowerCase(), now);
  }

  subscribersOf(maker: string): string[] {
    return (this.db.prepare('SELECT chat_id FROM tg_subs WHERE maker = ?').all(maker.toLowerCase()) as { chat_id: string }[]).map((r) => r.chat_id);
  }
}
