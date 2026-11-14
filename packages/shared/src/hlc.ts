import { z } from 'zod';
import { CLIENT_ID_PATTERN } from './ids.js';

/**
 * Hybrid logical clock (Kulkarni et al.), used to stamp every field write so that
 * merges are per-field last-writer-wins and deterministic on every replica.
 *
 * Serialised form (fixed width, so plain string comparison == causal/total order):
 *
 *   2026-11-14T06:55:22.564Z-0000-0123456789abcdef
 *   └ wall clock, ISO ms ──┘ └ctr┘ └ node id (16 hex) ┘
 *
 * - `wall` is milliseconds since the epoch (>= 0, < year 10000).
 * - `counter` is 0..0xffff. If it would overflow, the wall time is advanced by 1 ms instead,
 *   which preserves monotonicity.
 * - `node` is the client id of the replica that made the write (the server has its own).
 *
 * Compare serialised stamps with `<` / `compareHlcStrings`, never `localeCompare`.
 */

export interface Hlc {
  readonly wall: number;
  readonly counter: number;
  readonly node: string;
}

export const HLC_MAX_COUNTER = 0xffff;
const MAX_WALL = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** Recommended limit on how far ahead of the server's clock a pushed stamp may be. */
export const MAX_CLOCK_DRIFT_MS = 5 * 60 * 1000;

export const HLC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z-[0-9a-f]{4}-[0-9a-f]{16}$/;

export const hlcSchema = z.string().regex(HLC_PATTERN, 'invalid HLC timestamp');
export type HlcString = z.infer<typeof hlcSchema>;

export class HlcDriftError extends Error {
  constructor(
    readonly remoteWall: number,
    readonly now: number,
    readonly maxDriftMs: number,
  ) {
    super(`HLC drift too large: remote ${remoteWall - now}ms ahead (limit ${maxDriftMs}ms)`);
    this.name = 'HlcDriftError';
  }
}

function assertNode(node: string): void {
  if (!CLIENT_ID_PATTERN.test(node)) throw new Error(`invalid HLC node id: ${node}`);
}

function assertWall(wall: number): void {
  if (!Number.isInteger(wall) || wall < 0 || wall > MAX_WALL) {
    throw new Error(`invalid HLC wall time: ${wall}`);
  }
}

export function createHlc(node: string, wall = 0): Hlc {
  assertNode(node);
  assertWall(wall);
  return { wall, counter: 0, node };
}

export const HLC_ZERO_NODE = '0000000000000000';
/** The smallest possible stamp. Used for fields that have no clock. */
export const HLC_ZERO: HlcString = '1970-01-01T00:00:00.000Z-0000-0000000000000000';

function normalise(wall: number, counter: number, node: string): Hlc {
  if (counter > HLC_MAX_COUNTER) return { wall: wall + 1, counter: 0, node };
  return { wall, counter, node };
}

/** Advance the clock for a local event (an edit made on this replica). */
export function incrementHlc(local: Hlc, now: number): Hlc {
  const wall = Math.max(local.wall, Math.floor(now));
  const counter = wall === local.wall ? local.counter + 1 : 0;
  const next = normalise(wall, counter, local.node);
  assertWall(next.wall);
  return next;
}

export interface ReceiveOptions {
  /** Throw `HlcDriftError` if `remote.wall` is more than this many ms ahead of `now`. Default: no limit. */
  maxDriftMs?: number;
}

/** Merge a remote stamp into the local clock (on receiving a change from another replica). */
export function receiveHlc(
  local: Hlc,
  remote: Hlc,
  now: number,
  options: ReceiveOptions = {},
): Hlc {
  const nowMs = Math.floor(now);
  const maxDrift = options.maxDriftMs ?? Number.POSITIVE_INFINITY;
  if (remote.wall - nowMs > maxDrift) throw new HlcDriftError(remote.wall, nowMs, maxDrift);

  const wall = Math.max(local.wall, remote.wall, nowMs);
  let counter: number;
  if (wall === local.wall && wall === remote.wall) {
    counter = Math.max(local.counter, remote.counter) + 1;
  } else if (wall === local.wall) {
    counter = local.counter + 1;
  } else if (wall === remote.wall) {
    counter = remote.counter + 1;
  } else {
    counter = 0;
  }
  const next = normalise(wall, counter, local.node);
  assertWall(next.wall);
  return next;
}

export function compareHlc(a: Hlc, b: Hlc): -1 | 0 | 1 {
  if (a.wall !== b.wall) return a.wall < b.wall ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.node !== b.node) return a.node < b.node ? -1 : 1;
  return 0;
}

/** Ordinal comparison of serialised stamps (equivalent to `compareHlc` on parsed values). */
export function compareHlcStrings(a: string, b: string): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function serializeHlc(hlc: Hlc): HlcString {
  assertWall(hlc.wall);
  assertNode(hlc.node);
  if (!Number.isInteger(hlc.counter) || hlc.counter < 0 || hlc.counter > HLC_MAX_COUNTER) {
    throw new Error(`invalid HLC counter: ${hlc.counter}`);
  }
  return `${new Date(hlc.wall).toISOString()}-${hlc.counter.toString(16).padStart(4, '0')}-${hlc.node}`;
}

export function parseHlc(value: string): Hlc {
  if (!HLC_PATTERN.test(value)) throw new Error(`invalid HLC timestamp: ${value}`);
  const wall = Date.parse(value.slice(0, 24));
  if (Number.isNaN(wall)) throw new Error(`invalid HLC timestamp: ${value}`);
  return { wall, counter: parseInt(value.slice(25, 29), 16), node: value.slice(30) };
}

export function isHlcString(value: unknown): value is HlcString {
  return typeof value === 'string' && HLC_PATTERN.test(value);
}

export interface HlcClockOptions {
  /** Clock source; defaults to `Date.now`. */
  now?: () => number;
  /** Last stamp persisted by this replica, so the clock never goes backwards across restarts. */
  last?: HlcString;
  /** Passed to `receiveHlc`. */
  maxDriftMs?: number;
}

/**
 * Stateful clock for one replica. Persist `clock.current` (e.g. in IndexedDB `meta` or the
 * server `meta` table) and pass it back as `last` on startup.
 */
export class HlcClock {
  private state: Hlc;
  private readonly clock: () => number;
  private readonly maxDriftMs: number | undefined;

  constructor(node: string, options: HlcClockOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.maxDriftMs = options.maxDriftMs;
    const base = createHlc(node);
    if (options.last) {
      const last = parseHlc(options.last);
      this.state = { wall: last.wall, counter: last.counter, node };
    } else {
      this.state = base;
    }
  }

  get node(): string {
    return this.state.node;
  }

  /** The most recently issued or received stamp. */
  get current(): HlcString {
    return serializeHlc(this.state);
  }

  /** Issue a new stamp for a local write. */
  tick(): HlcString {
    this.state = incrementHlc(this.state, this.clock());
    return serializeHlc(this.state);
  }

  /** Observe a stamp from another replica. */
  receive(remote: HlcString): void {
    const opts: ReceiveOptions =
      this.maxDriftMs === undefined ? {} : { maxDriftMs: this.maxDriftMs };
    this.state = receiveHlc(this.state, parseHlc(remote), this.clock(), opts);
  }
}
