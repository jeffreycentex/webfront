import { compareBySortKey } from '@webfront/shared';

/** Pure shopping-list logic (parsing, duplicates, history ranking, grouping). No I/O. */

export interface ParsedEntry {
  name: string;
  quantity: string | null;
}

const NUM = String.raw`\d+(?:[.,]\d+)?`;
const COMPACT_UNITS = 'kg|g|mg|l|ml|cl|dl|oz|lb|lbs';
const WORD_UNITS =
  'packs?|pk|tins?|cans?|bottles?|bags?|boxes|box|jars?|dozen|doz|loaf|loaves|bunch(?:es)?|cartons?|rolls?|punnets?';

const leadingCompact = new RegExp(`^(${NUM})\\s*(${COMPACT_UNITS})\\s+(?:of\\s+)?(.+)$`, 'i');
const leadingWord = new RegExp(`^(${NUM})\\s*(${WORD_UNITS})\\s+(?:of\\s+)?(.+)$`, 'i');
const leadingCount = new RegExp(`^(${NUM})\\s*[x×]?\\s+(.+)$`, 'i');
const leadingCountX = new RegExp(`^(${NUM})\\s*[x×]\\s*(\\D.*)$`, 'i');
const trailingTimes = new RegExp(`^(.+?)\\s+(?:[x×]\\s*(${NUM})|(${NUM})\\s*[x×])$`, 'i');
const trailingCompact = new RegExp(`^(.+?)\\s+(${NUM})\\s*(${COMPACT_UNITS})$`, 'i');

function num(s: string): string {
  return s.replace(',', '.');
}

/**
 * Split "2 milk", "milk x2", "500g flour", "2x eggs" into a name and quantity.
 * Anything it cannot read confidently stays in the name.
 */
export function parseQuantity(input: string): ParsedEntry {
  const text = input.replace(/\s+/g, ' ').trim();
  if (!text) return { name: '', quantity: null };
  let m = leadingCompact.exec(text);
  if (m) return { name: m[3]!.trim(), quantity: `${num(m[1]!)}${m[2]!.toLowerCase()}` };
  m = leadingWord.exec(text);
  if (m) return { name: m[3]!.trim(), quantity: `${num(m[1]!)} ${m[2]!.toLowerCase()}` };
  m = leadingCountX.exec(text);
  if (m) return { name: m[2]!.trim(), quantity: num(m[1]!) };
  m = leadingCount.exec(text);
  if (m) return { name: m[2]!.trim(), quantity: num(m[1]!) };
  m = trailingTimes.exec(text);
  if (m) return { name: m[1]!.trim(), quantity: num((m[2] ?? m[3])!) };
  m = trailingCompact.exec(text);
  if (m) return { name: m[1]!.trim(), quantity: `${num(m[2]!)}${m[3]!.toLowerCase()}` };
  return { name: text, quantity: null };
}

/** Key used to compare names: case, spacing and trailing punctuation insensitive. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!,;:]+$/, '')
    .trim();
}

/** "Milk" from "milk" etc: capitalise the first letter only when the input is all lower-case. */
export function tidyName(name: string): string {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) return n;
  return n === n.toLowerCase() ? n.charAt(0).toUpperCase() + n.slice(1) : n;
}

interface QtyParts {
  n: number;
  unit: string;
}

function qtyParts(q: string | null | undefined): QtyParts | null {
  if (q == null || q.trim() === '') return { n: 1, unit: '' };
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(q.trim().replace(',', '.'));
  if (!m) return null;
  return { n: Number(m[1]), unit: m[2]!.toLowerCase() };
}

function formatQty(p: QtyParts, original: string | null): string {
  const n = Number.isInteger(p.n) ? String(p.n) : String(Math.round(p.n * 100) / 100);
  if (!p.unit) return n;
  return original && /\s/.test(original.trim()) ? `${n} ${p.unit}` : `${n}${p.unit}`;
}

/**
 * Add `added` to `existing`. Returns the new quantity, or null when the two cannot be combined
 * (different units or free text), in which case callers just flash the existing row.
 */
export function bumpQuantity(existing: string | null, added: string | null): string | null {
  const a = qtyParts(existing);
  const b = qtyParts(added);
  if (!a || !b) return null;
  if (a.unit !== b.unit) return null;
  const unit = a.unit;
  return formatQty({ n: a.n + b.n, unit }, existing ?? added);
}

export interface ItemLike {
  id: string;
  name: string;
  checked: boolean;
  quantity: string | null;
  section: string | null;
  sortKey: string;
}

/** Existing item with the same name on the list; unchecked matches win over checked ones. */
export function findDuplicate<T extends ItemLike>(
  items: readonly T[],
  name: string,
): T | undefined {
  const key = nameKey(name);
  if (!key) return undefined;
  let checkedMatch: T | undefined;
  for (const it of items) {
    if (nameKey(it.name) !== key) continue;
    if (!it.checked) return it;
    checkedMatch ??= it;
  }
  return checkedMatch;
}

// ---------------------------------------------------------------------------------------------
// History and autocomplete

export interface HistoryItem {
  name: string;
  updatedAt: string;
  section: string | null;
}

export interface HistoryEntry {
  key: string;
  name: string;
  count: number;
  lastUsed: number;
  section: string | null;
}

/** Collapse every item ever added (including cleared ones) into one entry per name. */
export function buildHistory(items: readonly HistoryItem[]): HistoryEntry[] {
  const map = new Map<string, HistoryEntry & { sectionAt: number }>();
  for (const it of items) {
    const key = nameKey(it.name);
    if (!key) continue;
    const at = Date.parse(it.updatedAt) || 0;
    const e = map.get(key);
    if (!e) {
      map.set(key, {
        key,
        name: it.name,
        count: 1,
        lastUsed: at,
        section: it.section,
        sectionAt: it.section ? at : -1,
      });
      continue;
    }
    e.count += 1;
    if (at >= e.lastUsed) {
      e.lastUsed = at;
      e.name = it.name;
    }
    if (it.section && at >= e.sectionAt) {
      e.section = it.section;
      e.sectionAt = at;
    }
  }
  return [...map.values()].map(({ sectionAt: _s, ...e }) => e);
}

const DAY = 86_400_000;

/** Frequency plus a recency bonus that halves every 30 days. */
export function historyScore(e: HistoryEntry, now: number): number {
  const age = Math.max(0, now - e.lastUsed) / DAY;
  return e.count + 3 * Math.pow(0.5, age / 30);
}

/**
 * Rank history entries for the typed text: prefix matches, then word-start, then substring;
 * within a tier by frequency and recency. Empty text gives the overall favourites.
 */
export function suggest(
  history: readonly HistoryEntry[],
  query: string,
  limit = 6,
  now = Date.now(),
): HistoryEntry[] {
  const q = nameKey(query);
  const scored: Array<{ e: HistoryEntry; tier: number; score: number }> = [];
  for (const e of history) {
    let tier = 0;
    if (q) {
      if (e.key.startsWith(q)) tier = 0;
      else if (e.key.split(' ').some((w) => w.startsWith(q))) tier = 1;
      else if (e.key.includes(q)) tier = 2;
      else continue;
    }
    scored.push({ e, tier, score: historyScore(e, now) });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier || b.score - a.score || (a.e.key < b.e.key ? -1 : a.e.key > b.e.key ? 1 : 0),
  );
  return scored.slice(0, limit).map((s) => s.e);
}

// ---------------------------------------------------------------------------------------------
// Sections

export const FALLBACK_SECTION = 'Other';

export interface SectionGroup<T> {
  section: string;
  items: T[];
}

/**
 * Group unchecked items by store section, in the list's section order. Items with no section
 * (or one the list no longer has) go to "Other": its slot if the list has it, else the end.
 * Empty sections are omitted. Items inside a group follow `sortKey`.
 */
export function groupBySection<T extends ItemLike>(
  items: readonly T[],
  sections: readonly string[],
): SectionGroup<T>[] {
  const known = new Set(sections);
  const buckets = new Map<string, T[]>();
  const extra: string[] = [];
  for (const it of [...items].sort(compareBySortKey)) {
    let s = it.section && it.section.trim() ? it.section : FALLBACK_SECTION;
    if (!known.has(s) && s !== FALLBACK_SECTION) s = FALLBACK_SECTION;
    if (!buckets.has(s)) {
      buckets.set(s, []);
      if (!known.has(s)) extra.push(s);
    }
    buckets.get(s)!.push(it);
  }
  const out: SectionGroup<T>[] = [];
  for (const s of sections) {
    const list = buckets.get(s);
    if (list?.length) out.push({ section: s, items: list });
  }
  for (const s of extra) out.push({ section: s, items: buckets.get(s)! });
  return out;
}

/** Which section name an item shows under (mirrors `groupBySection`). */
export function effectiveSection(
  item: Pick<ItemLike, 'section'>,
  sections: readonly string[],
): string {
  const s = item.section && item.section.trim() ? item.section : FALLBACK_SECTION;
  return sections.includes(s) || s === FALLBACK_SECTION ? s : FALLBACK_SECTION;
}

/** Split into to-buy and in-the-trolley, each ordered by sortKey. */
export function splitChecked<T extends ItemLike>(items: readonly T[]) {
  const sorted = [...items].sort(compareBySortKey);
  return { open: sorted.filter((i) => !i.checked), checked: sorted.filter((i) => i.checked) };
}

// ---------------------------------------------------------------------------------------------
// Staples
//
// A staple is an item record of the list with `staple: true`. Soft-deleted records count (that is
// how staples survive "Clear checked"). Several records can share a name (an item typed again
// after the flagged one was cleared); they collapse to one staple, represented by the most
// recently updated flagged record.

export interface StapleRecord extends ItemLike {
  note: string;
  staple: boolean;
  deleted?: boolean;
  updatedAt: string;
}

export interface Staple {
  key: string;
  /** Id of the representative record (the one edits are written to). */
  recordId: string;
  name: string;
  quantity: string | null;
  section: string | null;
  note: string;
  /** Alphabetical ordering inside a section (groupBySection sorts by this). */
  sortKey: string;
  checked: false;
  id: string;
}

/** One staple per name from a list's records (soft-deleted included). */
export function deriveStaples(records: readonly StapleRecord[]): Staple[] {
  const best = new Map<string, StapleRecord>();
  for (const r of records) {
    if (!r.staple) continue;
    const key = nameKey(r.name);
    if (!key) continue;
    const cur = best.get(key);
    if (!cur || (Date.parse(r.updatedAt) || 0) >= (Date.parse(cur.updatedAt) || 0))
      best.set(key, r);
  }
  return [...best.entries()]
    .map(([key, r]) => ({
      key,
      recordId: r.id,
      id: r.id,
      name: r.name,
      quantity: r.quantity,
      section: r.section,
      note: r.note,
      sortKey: key,
      checked: false as const,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export type StapleState = 'missing' | 'on-list' | 'in-trolley';

/** Where a staple stands against the list's live (not deleted) items. */
export function stapleState(staple: Pick<Staple, 'name'>, live: readonly ItemLike[]): StapleState {
  const dup = findDuplicate(live, staple.name);
  if (!dup) return 'missing';
  return dup.checked ? 'in-trolley' : 'on-list';
}

export interface StapleAction {
  kind: 'add' | 'uncheck';
  staple: Staple;
  /** The live checked item to uncheck (kind 'uncheck'). */
  itemId?: string;
}

/**
 * What "Add all missing" does: staples already on the list unchecked are left alone, checked
 * ones are unchecked, absent ones are added (same rules as `addItem`).
 */
export function planAddStaples(
  staples: readonly Staple[],
  live: readonly ItemLike[],
): StapleAction[] {
  const out: StapleAction[] = [];
  for (const staple of staples) {
    const dup = findDuplicate(live, staple.name);
    if (!dup) out.push({ kind: 'add', staple });
    else if (dup.checked) out.push({ kind: 'uncheck', staple, itemId: dup.id });
  }
  return out;
}

/** Staples that are not on the list at all (the badge count). Checked ones count as present. */
export function missingStaples(staples: readonly Staple[], live: readonly ItemLike[]): Staple[] {
  return staples.filter((s) => stapleState(s, live) === 'missing');
}

/** Group staples by store section in the list's order (alphabetical inside a section). */
export function groupStaples(
  staples: readonly Staple[],
  sections: readonly string[],
): SectionGroup<Staple>[] {
  return groupBySection(staples, sections);
}
