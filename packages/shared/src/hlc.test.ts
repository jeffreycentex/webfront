import { describe, expect, it } from 'vitest';
import {
  HLC_MAX_COUNTER,
  HLC_ZERO,
  HlcClock,
  HlcDriftError,
  compareHlc,
  compareHlcStrings,
  createHlc,
  incrementHlc,
  isHlcString,
  parseHlc,
  receiveHlc,
  serializeHlc,
} from './hlc.js';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const T = Date.UTC(2026, 10, 14, 12, 0, 0, 0);

describe('HLC', () => {
  it('serialises to a fixed-width string and parses back', () => {
    const h = { wall: T, counter: 42, node: A };
    const s = serializeHlc(h);
    expect(s).toBe('2026-11-14T12:00:00.000Z-002a-aaaaaaaaaaaaaaaa');
    expect(s).toHaveLength(46);
    expect(parseHlc(s)).toEqual(h);
    expect(isHlcString(s)).toBe(true);
    expect(isHlcString('nope')).toBe(false);
    expect(serializeHlc(createHlc('0000000000000000'))).toBe(HLC_ZERO);
  });

  it('rejects invalid nodes, counters and strings', () => {
    expect(() => createHlc('XYZ')).toThrow();
    expect(() => serializeHlc({ wall: T, counter: HLC_MAX_COUNTER + 1, node: A })).toThrow();
    expect(() => serializeHlc({ wall: -1, counter: 0, node: A })).toThrow();
    expect(() => parseHlc('2026-11-14T12:00:00.000Z-002a-AAAA')).toThrow();
  });

  it('string order matches compareHlc', () => {
    const stamps = [
      { wall: T, counter: 0, node: B },
      { wall: T, counter: 1, node: A },
      { wall: T + 1, counter: 0, node: A },
      { wall: T, counter: 0, node: A },
      { wall: 0, counter: 0xffff, node: B },
      { wall: T + 1000 * 3600 * 24 * 365 * 10, counter: 3, node: A },
    ];
    const byStruct = [...stamps].sort(compareHlc).map(serializeHlc);
    const byString = stamps.map(serializeHlc).sort(compareHlcStrings);
    expect(byString).toEqual(byStruct);
  });

  it('increment uses physical time when it moves forward, else bumps the counter', () => {
    const h0 = createHlc(A, T);
    const h1 = incrementHlc(h0, T + 5);
    expect(h1).toEqual({ wall: T + 5, counter: 0, node: A });
    const h2 = incrementHlc(h1, T + 5);
    expect(h2).toEqual({ wall: T + 5, counter: 1, node: A });
    // Clock went backwards: logical time still advances.
    const h3 = incrementHlc(h2, T - 1000);
    expect(h3).toEqual({ wall: T + 5, counter: 2, node: A });
    expect(compareHlc(h3, h2)).toBe(1);
  });

  it('counter overflow advances wall by 1ms instead of throwing', () => {
    const h = { wall: T, counter: HLC_MAX_COUNTER, node: A };
    expect(incrementHlc(h, T)).toEqual({ wall: T + 1, counter: 0, node: A });
  });

  it('receive is strictly greater than both local and remote', () => {
    const local = { wall: T, counter: 3, node: A };
    const remote = { wall: T, counter: 7, node: B };
    const r1 = receiveHlc(local, remote, T - 10);
    expect(r1).toEqual({ wall: T, counter: 8, node: A });
    expect(compareHlc(r1, local)).toBe(1);
    expect(compareHlc(r1, remote)).toBe(1);

    const ahead = { wall: T + 100, counter: 2, node: B };
    expect(receiveHlc(local, ahead, T)).toEqual({ wall: T + 100, counter: 3, node: A });
    expect(receiveHlc(local, remote, T + 500)).toEqual({ wall: T + 500, counter: 0, node: A });
    expect(receiveHlc({ wall: T + 50, counter: 1, node: A }, remote, T)).toEqual({
      wall: T + 50,
      counter: 2,
      node: A,
    });
  });

  it('receive enforces the optional drift limit', () => {
    const local = createHlc(A, T);
    const remote = { wall: T + 60_001, counter: 0, node: B };
    expect(() => receiveHlc(local, remote, T, { maxDriftMs: 60_000 })).toThrow(HlcDriftError);
    expect(() => receiveHlc(local, remote, T)).not.toThrow();
  });

  it('HlcClock issues strictly increasing stamps and survives restarts', () => {
    let now = T;
    const clock = new HlcClock(A, { now: () => now });
    const s1 = clock.tick();
    const s2 = clock.tick();
    now -= 5000; // clock skew backwards
    const s3 = clock.tick();
    expect(s1 < s2 && s2 < s3).toBe(true);

    clock.receive(serializeHlc({ wall: T + 10_000, counter: 9, node: B }));
    const s4 = clock.tick();
    expect(s4 > serializeHlc({ wall: T + 10_000, counter: 9, node: B })).toBe(true);

    const restarted = new HlcClock(A, { now: () => T, last: clock.current });
    expect(restarted.tick() > s4).toBe(true);
  });
});
