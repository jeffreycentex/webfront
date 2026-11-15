import type { NotificationOptions, RecordOf, ServiceCheck } from '@webfront/shared';
import { cleanText, LIMITS, type PushoverMessage } from './pushover.js';

/**
 * Alert rules (pure: no I/O, no timers; the clock is passed in).
 *
 * Input per sweep: the checker's *confirmed* state of every current service (after its
 * 2-consecutive-failures flap protection), plus the persisted alert row of each.
 *
 * - First sighting (no row yet: server upgraded to this version, bookmark newly flagged as a
 *   service, or a restored database): a baseline row is written and nothing is sent. A service
 *   first seen down is alerted only after it has been seen up once, so pre-existing outages and
 *   services that never worked do not page.
 * - up -> down (confirmed): the outage starts (`downSince` = this sweep). The down alert is due
 *   once it has lasted `minDownMinutes` (0 = this same sweep). A recovery before that sends
 *   nothing at all.
 * - When the alert is due: if notifications are active it is sent and the outage is `raised`;
 *   if they are off (disabled, not configured, or "notify on down" off) the outage is still
 *   marked as qualifying, and a recovery is sent only if "notify on recovery" is on and
 *   notifications are active at that moment. Outages that qualified while notifications were
 *   disabled or unconfigured are `muted`: no recovery for them.
 * - Still down and `raised`: a reminder every `repeatMinutes` (if set) after the last alert.
 * - down -> up after a `raised` outage: one recovery message with the outage duration.
 * - Services that were deleted or un-flagged: their rows are dropped silently.
 * - Every change of state is persisted in the same pass, so each transition is acted on
 *   exactly once, and a restart resumes from the stored rows (no alert storm).
 */

export type AlertPhase = 'none' | 'pending' | 'raised' | 'muted';

export interface AlertRow {
  bookmarkId: string;
  state: 'up' | 'down';
  seenUp: boolean;
  downSince: number | null;
  alert: AlertPhase;
  lastAlertAt: number | null;
}

export interface Observation {
  bookmark: Pick<RecordOf<'bookmarks'>, 'id' | 'title' | 'url'> & { serviceCheck: ServiceCheck };
  /** Confirmed state written to `serviceStatuses`. */
  state: 'up' | 'down';
  /** Checker's failure reason when down ("HTTP 503", "ECONNREFUSED", "Timed out"). */
  reason: string | null;
}

export interface AlertItem {
  name: string;
  host: string;
  url: string | null;
  reason: string | null;
  /** ms epoch the outage was confirmed. */
  downSince: number;
  /** Reminder for an outage that was already reported. */
  reminder: boolean;
}

export interface RecoveryItem {
  name: string;
  host: string;
  url: string | null;
  downForMs: number;
}

export interface EvaluateInput {
  rows: ReadonlyMap<string, AlertRow>;
  observations: readonly Observation[];
  /** Ids of every current service (rows of other ids are dropped). */
  currentIds: ReadonlySet<string>;
  options: NotificationOptions;
  /** Enabled and both credentials present (and not paused after a rejection). */
  active: boolean;
  now: number;
}

export interface EvaluateResult {
  upserts: AlertRow[];
  deletes: string[];
  down: AlertItem[];
  recovered: RecoveryItem[];
}

const MIN = 60_000;

export function evaluateAlerts(input: EvaluateInput): EvaluateResult {
  const { rows, options, active, now } = input;
  const out: EvaluateResult = { upserts: [], deletes: [], down: [], recovered: [] };
  const sendDown = active && options.notifyDown;

  for (const obs of input.observations) {
    const id = obs.bookmark.id;
    const prev = rows.get(id);
    if (!prev) {
      out.upserts.push({
        bookmarkId: id,
        state: obs.state,
        seenUp: obs.state === 'up',
        downSince: obs.state === 'down' ? now : null,
        alert: 'none',
        lastAlertAt: null,
      });
      continue;
    }
    const row: AlertRow = { ...prev };

    if (obs.state === 'up') {
      if (prev.state === 'down') {
        if (prev.alert === 'raised' && active && options.notifyRecovery) {
          out.recovered.push({
            ...describe(obs),
            downForMs: Math.max(0, now - (prev.downSince ?? now)),
          });
        }
        row.state = 'up';
        row.downSince = null;
        row.alert = 'none';
        row.lastAlertAt = null;
      }
      row.seenUp = true;
    } else {
      if (prev.state === 'up') {
        row.state = 'down';
        row.downSince = now;
        row.alert = 'pending'; // it was up, so it has been seen up
        row.lastAlertAt = null;
      }
      const since = row.downSince ?? now;
      if (row.alert === 'pending' && now - since >= options.minDownMinutes * MIN) {
        if (sendDown) {
          out.down.push({
            ...describe(obs),
            reason: obs.reason,
            downSince: since,
            reminder: false,
          });
          row.alert = 'raised';
          row.lastAlertAt = now;
        } else {
          // Qualifies, but nothing is sent now. Recovery still follows if notifications are
          // active (only "notify on down" is off); otherwise the outage stays silent.
          row.alert = active ? 'raised' : 'muted';
          row.lastAlertAt = now;
        }
      } else if (
        row.alert === 'raised' &&
        sendDown &&
        options.repeatMinutes > 0 &&
        now - (row.lastAlertAt ?? since) >= options.repeatMinutes * MIN
      ) {
        out.down.push({ ...describe(obs), reason: obs.reason, downSince: since, reminder: true });
        row.lastAlertAt = now;
      }
    }
    if (!sameRow(prev, row)) out.upserts.push(row);
  }

  for (const id of rows.keys()) if (!input.currentIds.has(id)) out.deletes.push(id);
  return out;
}

function sameRow(a: AlertRow, b: AlertRow): boolean {
  return (
    a.state === b.state &&
    a.seenUp === b.seenUp &&
    a.downSince === b.downSince &&
    a.alert === b.alert &&
    a.lastAlertAt === b.lastAlertAt
  );
}

/* -------------------------------------------------------------------------------------------
 * Message text
 * ----------------------------------------------------------------------------------------- */

/** Host (and port) the service is checked at: never credentials, path or query string. */
export function targetHost(bookmark: Observation['bookmark']): string {
  const check = bookmark.serviceCheck;
  if (check.type === 'tcp') {
    const h =
      check.host.includes(':') && !check.host.startsWith('[') ? `[${check.host}]` : check.host;
    return `${h}:${check.port}`;
  }
  try {
    return new URL(check.url ?? bookmark.url).host || 'unknown host';
  } catch {
    return 'unknown host';
  }
}

/** The bookmark's address for Pushover's `url` field: http(s) only, without credentials, query or fragment. */
export function linkUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const s = `${u.protocol}//${u.host}${u.pathname}`;
    return s.length <= LIMITS.url ? s : `${u.protocol}//${u.host}/`;
  } catch {
    return null;
  }
}

function describe(obs: Observation) {
  const host = cleanText(targetHost(obs.bookmark), 120);
  const name = cleanText(obs.bookmark.title, 80).trim() || host;
  return { name, host, url: linkUrl(obs.bookmark.url) };
}

export function formatDuration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / MIN));
  if (mins < 1) return 'under a minute';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 48) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

const PRIORITY = { low: -1, normal: 0, high: 1 } as const;

/** Join lines, stopping before the message limit with "…and N more". */
function joinLines(head: string, lines: string[]): string {
  const out: string[] = head ? [head] : [];
  let len = head.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const rest = lines.length - i - 1;
    const tail = rest > 0 ? `\n…and ${rest} more` : '';
    if (len + 1 + line.length + tail.length > LIMITS.message - 20) {
      out.push(`…and ${lines.length - i} more`);
      break;
    }
    out.push(line);
    len += 1 + line.length;
  }
  return out.join('\n');
}

/** One combined message for every service that went down (or is still down) in a sweep. */
export function downMessage(
  items: readonly AlertItem[],
  options: NotificationOptions,
  now: number,
): PushoverMessage | null {
  if (items.length === 0) return null;
  const line = (i: AlertItem) =>
    i.reminder
      ? `${i.name} (${i.host}) still down after ${formatDuration(now - i.downSince)}${i.reason ? `: ${i.reason}` : ''}`
      : `${i.name} (${i.host}) is down${i.reason ? `: ${i.reason}` : ''}`;
  const base = {
    priority: PRIORITY[options.downPriority],
    sound: options.sound,
    device: options.device,
    timestamp: Math.floor(now / 1000),
  };
  if (items.length === 1) {
    const i = items[0]!;
    return {
      ...base,
      title: `${i.reminder ? 'Still down' : 'Down'}: ${i.name}`,
      message: line(i),
      url: i.url,
      urlTitle: i.url ? `Open ${i.name}` : null,
    };
  }
  const allReminders = items.every((i) => i.reminder);
  return {
    ...base,
    title: `${items.length} services ${allReminders ? 'still down' : 'down'}`,
    message: joinLines(
      '',
      items.map((i) => `• ${line(i)}`),
    ),
  };
}

/** One combined message for every service that recovered in a sweep. */
export function recoveryMessage(
  items: readonly RecoveryItem[],
  options: NotificationOptions,
  now: number,
): PushoverMessage | null {
  if (items.length === 0) return null;
  const base = {
    priority: PRIORITY[options.recoveryPriority],
    sound: options.sound,
    device: options.device,
    timestamp: Math.floor(now / 1000),
  };
  if (items.length === 1) {
    const i = items[0]!;
    return {
      ...base,
      title: `Up: ${i.name}`,
      message: `${i.name} (${i.host}) is back up after ${formatDuration(i.downForMs)} down`,
      url: i.url,
      urlTitle: i.url ? `Open ${i.name}` : null,
    };
  }
  return {
    ...base,
    title: `${items.length} services back up`,
    message: joinLines(
      '',
      items.map((i) => `• ${i.name} (${i.host}) back up after ${formatDuration(i.downForMs)}`),
    ),
  };
}
