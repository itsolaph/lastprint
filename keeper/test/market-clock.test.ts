import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CalendarRangeError,
  closedWindow,
  isUsMarketOpen,
  lastClose,
  marketState,
  nextClose,
  nextOpen,
  sessionOn,
} from '../src/shared/market-clock.ts';

const t = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

describe('market clock: regular week', () => {
  it('Thursday evening ET is closed; last close Thu 16:00 EST, next open Fri 09:30 EST', () => {
    const now = t('2026-11-13T03:00:00Z'); // Thu 22:00 ET
    assert.equal(isUsMarketOpen(now), false);
    assert.equal(iso(lastClose(now)), '2026-11-12T21:00:00.000Z');
    assert.equal(iso(nextOpen(now)), '2026-11-13T14:30:00.000Z');
    assert.equal(marketState(now).reason, 'Overnight');
  });

  it('open boundaries are [09:30, 16:00)', () => {
    assert.equal(isUsMarketOpen(t('2026-11-13T14:29:59Z')), false);
    assert.equal(isUsMarketOpen(t('2026-11-13T14:30:00Z')), true);
    assert.equal(isUsMarketOpen(t('2026-11-13T20:59:59Z')), true);
    assert.equal(isUsMarketOpen(t('2026-11-13T21:00:00Z')), false);
  });

  it('during the session: last close is the previous day, next close is today', () => {
    const now = t('2026-11-13T16:00:00Z');
    assert.equal(iso(lastClose(now)), '2026-11-12T21:00:00.000Z');
    assert.equal(iso(nextClose(now)), '2026-11-13T21:00:00.000Z');
    assert.equal(iso(nextOpen(now)), '2026-11-16T14:30:00.000Z');
    assert.equal(closedWindow(now), null);
    assert.equal(marketState(now).open, true);
  });

  it('weekend: closed, reason Weekend, next open Monday', () => {
    const now = t('2026-11-14T18:00:00Z');
    assert.equal(isUsMarketOpen(now), false);
    assert.equal(marketState(now).reason, 'Weekend');
    assert.equal(iso(lastClose(now)), '2026-11-13T21:00:00.000Z');
    assert.equal(iso(nextOpen(now)), '2026-11-16T14:30:00.000Z');
    const w = closedWindow(now)!;
    assert.equal(iso(w.start), '2026-11-13T21:00:00.000Z');
    assert.equal(iso(w.end), '2026-11-16T14:30:00.000Z');
  });
});

describe('market clock: DST boundaries', () => {
  it('spring forward 2026-03-08: Friday closes 21:00Z (EST), Monday opens 13:30Z (EDT)', () => {
    const sat = t('2026-03-07T12:00:00Z');
    assert.equal(iso(lastClose(sat)), '2026-03-06T21:00:00.000Z');
    assert.equal(iso(nextOpen(sat)), '2026-03-09T13:30:00.000Z');
    assert.equal(isUsMarketOpen(t('2026-03-09T13:29:59Z')), false);
    assert.equal(isUsMarketOpen(t('2026-03-09T13:30:00Z')), true);
    assert.equal(isUsMarketOpen(t('2026-03-09T20:00:00Z')), false);
  });

  it('fall back 2026-11-01: Friday closes 20:00Z (EDT), Monday opens 14:30Z (EST)', () => {
    const sun = t('2026-11-01T12:00:00Z');
    assert.equal(iso(lastClose(sun)), '2026-10-30T20:00:00.000Z');
    assert.equal(iso(nextOpen(sun)), '2026-11-02T14:30:00.000Z');
    assert.equal(isUsMarketOpen(t('2026-11-02T14:29:00Z')), false);
    assert.equal(isUsMarketOpen(t('2026-11-02T20:59:00Z')), true);
  });

  it('2027 DST: Mar 14 and Nov 7', () => {
    assert.equal(iso(nextOpen(t('2027-03-13T12:00:00Z'))), '2027-03-15T13:30:00.000Z');
    assert.equal(iso(nextOpen(t('2027-11-06T12:00:00Z'))), '2027-11-08T14:30:00.000Z');
  });
});

describe('market clock: holidays and early closes', () => {
  it('Thanksgiving week 2026: Thu closed, Fri closes 13:00 ET, next open Monday', () => {
    const wedNight = t('2026-11-26T02:00:00Z');
    assert.equal(iso(lastClose(wedNight)), '2026-11-25T21:00:00.000Z');
    assert.equal(iso(nextOpen(wedNight)), '2026-11-27T14:30:00.000Z');

    const thanksgiving = t('2026-11-26T16:00:00Z');
    assert.equal(isUsMarketOpen(thanksgiving), false);
    assert.equal(marketState(thanksgiving).reason, 'Thanksgiving Day');
    assert.equal(sessionOn('2026-11-26'), null);

    const fri = sessionOn('2026-11-27')!;
    assert.equal(fri.early, true);
    assert.equal(iso(fri.close), '2026-11-27T18:00:00.000Z');
    assert.equal(isUsMarketOpen(t('2026-11-27T17:59:59Z')), true);
    assert.equal(isUsMarketOpen(t('2026-11-27T18:00:00Z')), false);
    const friAfter = t('2026-11-27T18:30:00Z');
    assert.equal(iso(lastClose(friAfter)), '2026-11-27T18:00:00.000Z');
    assert.equal(iso(nextOpen(friAfter)), '2026-11-30T14:30:00.000Z');
  });

  it('Christmas 2026: Dec 24 early close, Dec 25 closed', () => {
    assert.equal(iso(sessionOn('2026-12-24')!.close), '2026-12-24T18:00:00.000Z');
    assert.equal(sessionOn('2026-12-25'), null);
    assert.equal(iso(nextOpen(t('2026-12-24T19:00:00Z'))), '2026-12-28T14:30:00.000Z');
  });

  it("New Year: Dec 31 2026 regular session, next open Mon Jan 4 2027", () => {
    assert.equal(iso(sessionOn('2026-12-31')!.close), '2026-12-31T21:00:00.000Z');
    assert.equal(iso(nextOpen(t('2026-12-31T22:00:00Z'))), '2027-01-04T14:30:00.000Z');
  });

  it('Good Friday 2026 (Apr 3) and 2027 (Mar 26)', () => {
    assert.equal(iso(nextOpen(t('2026-04-02T21:00:00Z'))), '2026-04-06T13:30:00.000Z');
    assert.equal(sessionOn('2027-03-26'), null);
  });

  it('observed holidays 2026-07-03, 2027-06-18, 2027-07-05, 2027-12-24', () => {
    for (const d of ['2026-07-03', '2027-06-18', '2027-07-05', '2027-12-24']) assert.equal(sessionOn(d), null, d);
    // 2027-12-23 is a regular full day (no early close listed by NYSE)
    assert.equal(sessionOn('2027-12-23')!.early, false);
    assert.equal(iso(nextOpen(t('2027-12-23T22:00:00Z'))), '2027-12-27T14:30:00.000Z');
  });

  it('day after Thanksgiving 2027 is an early close', () => {
    assert.equal(sessionOn('2027-11-25'), null);
    assert.equal(iso(sessionOn('2027-11-26')!.close), '2027-11-26T18:00:00.000Z');
  });
});

describe('market clock: range', () => {
  it('fails closed outside 2026-2027', () => {
    assert.throws(() => sessionOn('2028-01-03'), CalendarRangeError);
    assert.throws(() => nextOpen(t('2027-12-31T22:00:00Z')), CalendarRangeError);
  });
});
