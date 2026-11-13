import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCommand } from '../src/telegram.ts';
import { gapLine } from '../src/report.ts';
import type { MarketSnapshot } from '../src/snapshot.ts';

describe('telegram commands', () => {
  it('parses /start deep links with an address (lowercased), and nothing else', () => {
    assert.deepEqual(parseCommand('/start 0x70997970C51812dc3A010C7d01b50e0d17dc79C8'), { cmd: 'start', maker: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' });
    assert.deepEqual(parseCommand('/start'), { cmd: 'start', maker: null });
    assert.deepEqual(parseCommand('/start notanaddress'), { cmd: 'start', maker: null });
    assert.deepEqual(parseCommand('/gap'), { cmd: 'gap' });
    assert.deepEqual(parseCommand('/gap@LastprintBot'), { cmd: 'gap' });
    assert.equal(parseCommand('/buy NVDA'), null);
    assert.equal(parseCommand('hello'), null);
  });

  it('gap lines are descriptive, never advice', () => {
    const m = { ticker: 'NVDA', gapPct: -0.95, lastClose: { price: '180.12' }, base: { midPerShare: 178.4 } } as unknown as MarketSnapshot;
    const line = gapLine(m);
    assert.match(line, /trades 0\.95% below last close/);
    assert.doesNotMatch(line, /\bbuy\b|\bsell\b/i);
  });
});
