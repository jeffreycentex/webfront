/** Time zone helpers built on Intl (no extra dependencies). */

const validCache = new Map<string, boolean>();

export function isValidZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  const cached = validCache.get(zone);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    ok = true;
  } catch {
    ok = false;
  }
  validCache.set(zone, ok);
  return ok;
}

export function systemZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(zone, f);
  }
  return f;
}

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock fields of an instant in `zone`. */
export function wallClockIn(ms: number, zone: string): WallClock {
  const parts = formatter(zone).formatToParts(new Date(ms));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/**
 * The instant at which `zone`'s wall clock reads `wall`. In a DST gap the time moves forward
 * (as most calendar software does); in an overlap the earlier instant wins.
 */
export function instantForWallClock(wall: WallClock, zone: string): number {
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const offsetAt = (ms: number) => {
    const w = wallClockIn(ms, zone);
    return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms;
  };
  let guess = asUtc - offsetAt(asUtc);
  const second = asUtc - offsetAt(guess);
  if (second !== guess) {
    // Crossed an offset change: prefer the earlier of the candidates that round-trips.
    const roundTrips = (ms: number) => {
      const w = wallClockIn(ms, zone);
      return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) === asUtc;
    };
    if (roundTrips(second) && (!roundTrips(guess) || second < guess)) guess = second;
    else if (!roundTrips(guess)) guess = Math.max(guess, second);
  }
  return guess;
}
