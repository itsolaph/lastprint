import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Store } from '../src/db.ts';
import { FINAL_AFTER_MS, LastCloseService, floatToE8, parseNasdaqHistorical, parseYahooChart, type Fetcher } from '../src/lastclose.ts';

// Trimmed real responses (2026-11-13).
const YAHOO = {
  chart: {
    result: [
      {
        meta: { symbol: 'NVDA', regularMarketPrice: 166.19 },
        timestamp: [1793975400, 1794234600, 1794321000, 1794407400, 1794493800],
        indicators: {
          quote: [{ close: [186.63999938964844, 178.6699981689453, 168.88999938964844, 173.72999572753906, 166.19000244140625] }],
        },
      },
    ],
    error: null,
  },
};

const NASDAQ = {
  data: {
    symbol: 'NVDA',
    tradesTable: {
      rows: [
        { date: '11/12/2026', close: '$166.19' },
        { date: '11/11/2026', close: '$173.73' },
        { date: '11/10/2026', close: '$1,168.89' },
      ],
    },
  },
};

describe('last close parsing', () => {
  it('converts floats without artefacts', () => {
    assert.equal(floatToE8(166.19000244140625), 16_619_000_000n);
    assert.equal(floatToE8(0.1 + 0.2), 30_000_000n);
    assert.throws(() => floatToE8(0));
    assert.throws(() => floatToE8(Number.NaN));
  });

  it('Yahoo: picks the bar whose New York date is the session date', () => {
    assert.equal(parseYahooChart(YAHOO, '2026-11-12'), 16_619_000_000n);
    assert.equal(parseYahooChart(YAHOO, '2026-11-11'), 17_373_000_000n);
    assert.equal(parseYahooChart(YAHOO, '2026-11-13'), null);
    assert.equal(parseYahooChart({}, '2026-11-12'), null);
    assert.equal(parseYahooChart({ chart: { result: [{ timestamp: [1794493800], indicators: { quote: [{ close: [null] }] } }] } }, '2026-11-12'), null);
  });

  it('Nasdaq: matches MM/DD/YYYY and strips $ and thousands separators', () => {
    assert.equal(parseNasdaqHistorical(NASDAQ, '2026-11-12'), 16_619_000_000n);
    assert.equal(parseNasdaqHistorical(NASDAQ, '2026-11-10'), 116_889_000_000n);
    assert.equal(parseNasdaqHistorical(NASDAQ, '2026-11-09'), null);
    assert.equal(parseNasdaqHistorical({ data: null }, '2026-11-12'), null);
  });
});

describe('LastCloseService', () => {
  const thuClose = Date.parse('2026-11-12T21:00:00Z');

  it('uses the fallback when the primary fails, and caches the final value', async () => {
    const store = new Store(':memory:');
    let yahooCalls = 0;
    let nasdaqCalls = 0;
    const yahoo: Fetcher = async () => {
      yahooCalls++;
      throw new Error('HTTP 429');
    };
    const nasdaq: Fetcher = async (_t, d) => {
      nasdaqCalls++;
      return d === '2026-11-12' ? 16_619_000_000n : null;
    };
    const svc = new LastCloseService(store, [{ name: 'yahoo', fetch: yahoo }, { name: 'nasdaq', fetch: nasdaq }]);
    const now = thuClose + FINAL_AFTER_MS + 1;
    const q = await svc.get('NVDA', now);
    assert.equal(q?.source, 'nasdaq');
    assert.equal(q?.closeE8, 16_619_000_000n);
    assert.equal(q?.final, true);
    assert.equal(q?.sessionDate, '2026-11-12');

    await svc.get('NVDA', now + 3_600_000);
    assert.equal(yahooCalls, 1, 'final value is served from cache');
    assert.equal(nasdaqCalls, 1);
  });

  it('marks a value fetched right after the bell as provisional and refetches later', async () => {
    const store = new Store(':memory:');
    let calls = 0;
    const src: Fetcher = async () => {
      calls++;
      return calls === 1 ? 16_600_000_000n : 16_619_000_000n;
    };
    const svc = new LastCloseService(store, [{ name: 'yahoo', fetch: src }]);
    const early = await svc.get('NVDA', thuClose + 60_000);
    assert.equal(early?.final, false);
    assert.equal(early?.closeE8, 16_600_000_000n);
    const late = await svc.get('NVDA', thuClose + FINAL_AFTER_MS + 120_000);
    assert.equal(late?.final, true);
    assert.equal(late?.closeE8, 16_619_000_000n);
  });

  it('returns null when every source fails and nothing is cached', async () => {
    const svc = new LastCloseService(new Store(':memory:'), [{ name: 'yahoo', fetch: async () => null }]);
    assert.equal(await svc.get('NVDA', thuClose + FINAL_AFTER_MS), null);
  });
});
