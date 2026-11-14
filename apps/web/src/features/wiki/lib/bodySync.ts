import type { RecordOf } from '@webfront/shared';
import { merge3 } from './diff3';
import { hashText } from './text';

/**
 * Body synchronisation for wiki pages: how concurrent offline edits of the same page body are
 * merged without losing text.
 *
 * ## Where the merge base comes from
 *
 * The record resolver must be synchronous and may not touch IndexedDB, so the common ancestor
 * cannot be loaded from `wikiRevisions` at merge time. Instead every replica keeps a small,
 * synchronous per-page `BodyState` (localStorage, shared by all tabs of the origin):
 *
 *   head       the latest body this replica wrote, merged or accepted;
 *   own        whether `head` contains local edits that no other replica has yet been seen to
 *              build on (so it must be protected when a different body arrives);
 *   base       the `bodyBase` this replica writes with its own edits: the fingerprint of the
 *              text its current run of edits started from;
 *   ancestors  a few texts known to be ancestors of `head` (the text each run of edits started
 *              from, merge inputs and outputs, and the last few local saves), by fingerprint.
 *
 * Every body write also writes `bodyBase` (a synced field): the fingerprint of the text that
 * body was derived from. When a different body arrives while `own` is set:
 *
 *   - `bodyBase` equals the fingerprint of our head        → it was built on our text: accept;
 *   - `bodyBase` names one of our ancestors                → three-way merge against that text
 *     (an exact common ancestor of both sides, because the other replica declared it as its
 *     starting point and we hold it as one of ours);
 *   - otherwise (unknown ancestor)                          → conflict: keep both.
 *
 * A diff3 is therefore only ever run against a text both sides provably descend from, and in
 * every other case both versions are kept. This runs in two places with the same decision
 * function: the record resolver (a pull meets a pending local edit) and the reconciler (after
 * a pull replaced a body that this replica had already pushed, e.g. when the other device
 * pushed a newer stamp first: plain LWW would otherwise silently drop one side).
 */

export const MAX_RECENT_ANCESTORS = 4;
export const MAX_PINNED_ANCESTORS = 3;
/** Texts larger than this are not kept as "recent" ancestors (pinned ones always are). */
export const MAX_RECENT_TEXT = 300_000;
/** Prefix of `bodyBase` on conflict writes: "built on that text, kept as the conflict side". */
export const CONFLICT_BASE_PREFIX = 'c:';

export interface Ancestor {
  h: string;
  text: string;
  /** Start-of-run / merge texts (kept longer than ordinary recent saves). */
  pin: boolean;
}

export interface BodyState {
  head: string;
  own: boolean;
  base: string | null;
  ancestors: Ancestor[];
  updatedAt: number;
}

export interface BodyStateStore {
  get(pageId: string): BodyState | undefined;
  set(pageId: string, state: BodyState): void;
  delete(pageId: string): void;
  /** Page ids with a stored state. */
  keys(): string[];
}

/* -------------------------------------------------------------------------- stores */

export function createMemoryStore(): BodyStateStore {
  const map = new Map<string, BodyState>();
  return {
    get: (id) => {
      const s = map.get(id);
      return s ? structuredClone(s) : undefined;
    },
    set: (id, s) => void map.set(id, structuredClone(s)),
    delete: (id) => void map.delete(id),
    keys: () => [...map.keys()],
  };
}

const LS_PREFIX = 'webfront.wiki.body.';

function isBodyState(v: unknown): v is BodyState {
  const s = v as BodyState;
  return (
    !!s &&
    typeof s.head === 'string' &&
    typeof s.own === 'boolean' &&
    (s.base === null || typeof s.base === 'string') &&
    Array.isArray(s.ancestors)
  );
}

/**
 * localStorage-backed store (synchronous, shared by every tab of the origin). Falls back to
 * memory when storage is unavailable. When the quota is exceeded it drops the unpinned
 * ancestors first, then the state (an unknown state only makes the next merge a visible
 * conflict, never a silent loss).
 */
export function createLocalStorageStore(
  storage: Storage | undefined = safeLocalStorage(),
): BodyStateStore {
  if (!storage) return createMemoryStore();
  return {
    get(id) {
      try {
        const raw = storage.getItem(LS_PREFIX + id);
        if (!raw) return undefined;
        const parsed: unknown = JSON.parse(raw);
        return isBodyState(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    set(id, state) {
      const attempts: BodyState[] = [
        state,
        { ...state, ancestors: state.ancestors.filter((a) => a.pin) },
        { ...state, ancestors: state.ancestors.filter((a) => a.pin).slice(0, 1) },
      ];
      for (const s of attempts) {
        try {
          storage.setItem(LS_PREFIX + id, JSON.stringify(s));
          return;
        } catch {
          // quota: try a smaller state
        }
      }
      try {
        storage.removeItem(LS_PREFIX + id);
      } catch {
        // ignore
      }
    },
    delete(id) {
      try {
        storage.removeItem(LS_PREFIX + id);
      } catch {
        // ignore
      }
    },
    keys() {
      const out: string[] = [];
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          if (k?.startsWith(LS_PREFIX)) out.push(k.slice(LS_PREFIX.length));
        }
      } catch {
        // ignore
      }
      return out;
    },
  };
}

function safeLocalStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------------ state ops */

export function withAncestor(state: BodyState, text: string, pin: boolean): BodyState {
  if (!pin && text.length > MAX_RECENT_TEXT) return state;
  const h = hashText(text);
  const existing = state.ancestors.find((a) => a.h === h);
  const rest = state.ancestors.filter((a) => a.h !== h);
  const entry: Ancestor = { h, text, pin: pin || !!existing?.pin };
  const all = [entry, ...rest];
  const pinned = all.filter((a) => a.pin).slice(0, MAX_PINNED_ANCESTORS);
  const recent = all.filter((a) => !a.pin).slice(0, MAX_RECENT_ANCESTORS);
  const keep = new Set([...pinned, ...recent]);
  return { ...state, ancestors: all.filter((a) => keep.has(a)) };
}

/** State after accepting `body` (another replica's text, or one built on ours). */
export function acceptedState(body: string, now: number): BodyState {
  return withAncestor(
    { head: body, own: false, base: null, ancestors: [], updatedAt: now },
    body,
    true,
  );
}

export interface IncomingBody {
  body: string;
  bodyBase: string | null;
  /** Body kept in the incoming record's `conflict` (if any). */
  conflictBody: string | null;
}

export type BodyDecision =
  | { kind: 'same' }
  /** Take the incoming body as it is (it already contains our text, or we had none of our own). */
  | { kind: 'accept' }
  /** Our text supersedes the incoming one (incoming is an old version we already built on). */
  | { kind: 'mine' }
  | { kind: 'merged'; body: string; ancestor: string }
  | { kind: 'conflict'; reason: 'overlap' | 'unknown-base' };

/**
 * Decide what to do when `incoming` meets `mine` (our current text). `pending` forces "we
 * have our own edits" (the record resolver knows the body is still in the outbox).
 */
export function decideBody(
  state: BodyState | undefined,
  mine: string,
  incoming: IncomingBody,
  pending = false,
): BodyDecision {
  if (incoming.body === mine) return { kind: 'same' };
  const own = pending || !!state?.own;
  if (!own) return { kind: 'accept' };
  const mineHash = hashText(mine);
  const declared = incoming.bodyBase;
  if (declared === mineHash || declared === CONFLICT_BASE_PREFIX + mineHash)
    return { kind: 'accept' };
  if (incoming.conflictBody === mine) return { kind: 'accept' };
  const ancestors = state?.ancestors ?? [];
  const incomingHash = hashText(incoming.body);
  if (ancestors.some((a) => a.h === incomingHash)) return { kind: 'mine' };
  const ancestor = declared ? ancestors.find((a) => a.h === declared) : undefined;
  if (!ancestor) return { kind: 'conflict', reason: 'unknown-base' };
  const r = merge3(ancestor.text, mine, incoming.body);
  if (!r.clean) return { kind: 'conflict', reason: 'overlap' };
  if (r.merged === incoming.body) return { kind: 'accept' };
  if (r.merged === mine) return { kind: 'mine' };
  return { kind: 'merged', body: r.merged, ancestor: ancestor.text };
}

export interface WikiConflict {
  body: string;
  revisionId: string | null;
  detectedAt: string;
}

/** Fields to write for a decision, and the next state. */
export interface BodyOutcome {
  fields: {
    body?: string;
    bodyBase?: string | null;
    conflict?: WikiConflict | null;
  };
  state: BodyState;
  /** Texts worth snapshotting as revisions (pre-merge local text, the other side, the result). */
  snapshots: Array<{ body: string; label: 'mine' | 'theirs' | 'merged' }>;
}

export function applyDecision(
  decision: BodyDecision,
  state: BodyState | undefined,
  mine: string,
  incoming: IncomingBody & { conflict: WikiConflict | null },
  now: number,
): BodyOutcome {
  const base: BodyState = state ?? {
    head: mine,
    own: true,
    base: null,
    ancestors: [],
    updatedAt: now,
  };
  switch (decision.kind) {
    case 'same':
      return {
        fields: {},
        state: state ? { ...state, updatedAt: now } : acceptedState(mine, now),
        snapshots: [],
      };
    case 'accept':
      return {
        fields: { body: incoming.body, bodyBase: incoming.bodyBase, conflict: incoming.conflict },
        state: acceptedState(incoming.body, now),
        snapshots: [],
      };
    case 'mine': {
      const next = { ...base, head: mine, own: true, updatedAt: now };
      return { fields: { body: mine, bodyBase: next.base }, state: next, snapshots: [] };
    }
    case 'merged': {
      const declared = hashText(incoming.body);
      let next: BodyState = {
        ...base,
        head: decision.body,
        own: true,
        base: declared,
        updatedAt: now,
      };
      next = withAncestor(next, incoming.body, true);
      next = withAncestor(next, decision.body, true);
      return {
        fields: { body: decision.body, bodyBase: declared },
        state: next,
        snapshots: [
          { body: mine, label: 'mine' },
          { body: decision.body, label: 'merged' },
        ],
      };
    }
    case 'conflict': {
      const declared = CONFLICT_BASE_PREFIX + hashText(incoming.body);
      let next: BodyState = { ...base, head: mine, own: true, base: declared, updatedAt: now };
      next = withAncestor(next, mine, true);
      return {
        fields: {
          body: mine,
          bodyBase: declared,
          conflict: {
            body: incoming.body,
            revisionId: null,
            detectedAt: new Date(now).toISOString(),
          },
        },
        state: next,
        snapshots: [
          { body: mine, label: 'mine' },
          { body: incoming.body, label: 'theirs' },
        ],
      };
    }
  }
}

/**
 * Plan a local body save (call after reconciling, i.e. when `current.body` equals the state's
 * head or there is no state). Returns the `bodyBase` to write and the next state.
 */
export function planLocalSave(
  state: BodyState | undefined,
  current: { body: string; bodyBase: string | null },
  text: string,
  now: number,
): { bodyBase: string | null; state: BodyState } {
  let next: BodyState;
  if (state && state.own && state.head === current.body) {
    // Continuing our own run of edits: the previous save is an ancestor of the new text.
    next = withAncestor({ ...state }, current.body, false);
  } else {
    // Starting a run of edits from the current (synced or accepted) text.
    const prior = state && state.head === current.body ? state : acceptedState(current.body, now);
    next = withAncestor({ ...prior, own: true, base: hashText(current.body) }, current.body, true);
  }
  next = { ...next, head: text, updatedAt: now };
  return { bodyBase: next.base, state: next };
}

/* ------------------------------------------------------------------- record resolver */

export interface ResolverArgsLike {
  local: RecordOf<'wikiPages'>;
  remote: RecordOf<'wikiPages'>;
  merged: RecordOf<'wikiPages'>;
  pendingFields: Record<string, { value: unknown; hlc: string }>;
  conflictFields: string[];
}

export interface PendingSnapshot {
  pageId: string;
  title: string;
  body: string;
  label: 'mine' | 'theirs' | 'merged';
  /** Pre-assigned revision id (the merged one becomes the page's baseRevisionId). */
  id: string;
}

export interface WikiResolverOptions {
  store: BodyStateStore;
  now?: () => number;
  newId: () => string;
  /** Receives revision snapshots to write after the pull (must not write synchronously). */
  onSnapshots?: (snaps: PendingSnapshot[]) => void;
}

/**
 * The `wikiPages` record resolver: three-way merge of `body` when a pull meets a pending
 * local body edit that the remote changed concurrently. Synchronous; reads and writes only
 * the BodyStateStore. Other fields keep ordinary LWW.
 */
export function createWikiResolver(opts: WikiResolverOptions) {
  const now = opts.now ?? Date.now;
  return (args: ResolverArgsLike): Partial<RecordOf<'wikiPages'>> | undefined => {
    if (!args.conflictFields.includes('body') || !('body' in args.pendingFields)) return undefined;
    const pageId = args.local.id;
    const state = opts.store.get(pageId);
    const mine = String(args.pendingFields.body!.value ?? args.local.body);
    const incoming = {
      body: args.remote.body,
      bodyBase: args.remote.bodyBase,
      conflictBody: args.remote.conflict?.body ?? null,
      conflict: args.remote.conflict,
    };
    const t = now();
    const decision = decideBody(state, mine, incoming, true);
    const outcome = applyDecision(decision, state, mine, incoming, t);
    opts.store.set(pageId, outcome.state);

    const fields: Partial<RecordOf<'wikiPages'>> = { ...outcome.fields };
    if (outcome.snapshots.length > 0) {
      const title = args.merged.title;
      const snaps: PendingSnapshot[] = outcome.snapshots.map((s) => ({
        pageId,
        title,
        body: s.body,
        label: s.label,
        id: opts.newId(),
      }));
      const mergedSnap = snaps.find((s) => s.label === 'merged');
      if (mergedSnap) fields.baseRevisionId = mergedSnap.id;
      const theirs = snaps.find((s) => s.label === 'theirs');
      if (theirs && fields.conflict)
        fields.conflict = { ...fields.conflict, revisionId: theirs.id };
      opts.onSnapshots?.(snaps);
    }
    return fields;
  };
}

/* ------------------------------------------------------------------------ reconciler */

/** What the reconciler needs from the data layer (bound to `@/data` in the app, to a LocalStore in tests). */
export interface ReconcileIO {
  get(id: string): Promise<RecordOf<'wikiPages'> | undefined>;
  patch(id: string, changes: Partial<RecordOf<'wikiPages'>>): Promise<unknown>;
  snapshot(snap: PendingSnapshot): Promise<unknown>;
  /** Atomic local batch (one IndexedDB transaction): serialises with pulls. */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  newId(): string;
  now(): number;
}

function diffFields(
  rec: RecordOf<'wikiPages'>,
  fields: BodyOutcome['fields'],
): Partial<RecordOf<'wikiPages'>> {
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (JSON.stringify((rec as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v))
      changes[k] = v;
  }
  return changes as Partial<RecordOf<'wikiPages'>>;
}

function snapshotsFor(
  outcome: BodyOutcome,
  rec: RecordOf<'wikiPages'>,
  io: ReconcileIO,
  changes: Partial<RecordOf<'wikiPages'>>,
): PendingSnapshot[] {
  const snaps: PendingSnapshot[] = outcome.snapshots.map((s) => ({
    pageId: rec.id,
    title: rec.title,
    body: s.body,
    label: s.label,
    id: io.newId(),
  }));
  const mergedSnap = snaps.find((s) => s.label === 'merged');
  if (mergedSnap && 'body' in changes) changes.baseRevisionId = mergedSnap.id;
  const theirs = snaps.find((s) => s.label === 'theirs');
  if (theirs && changes.conflict) changes.conflict = { ...changes.conflict, revisionId: theirs.id };
  return snaps;
}

/** Reconcile inside an already open transaction. */
async function reconcileInTx(
  io: ReconcileIO,
  store: BodyStateStore,
  pageId: string,
): Promise<BodyDecision['kind'] | null> {
  const state = store.get(pageId);
  if (!state) return null;
  const rec = await io.get(pageId);
  if (!rec) return null;
  if (rec.body === state.head) return null;
  if (!state.own) {
    store.set(pageId, acceptedState(rec.body, io.now()));
    return 'accept';
  }
  const incoming = {
    body: rec.body,
    bodyBase: rec.bodyBase,
    conflictBody: rec.conflict?.body ?? null,
    conflict: rec.conflict,
  };
  const decision = decideBody(state, state.head, incoming);
  const outcome = applyDecision(decision, state, state.head, incoming, io.now());
  const changes = diffFields(rec, outcome.fields);
  const snaps = snapshotsFor(outcome, rec, io, changes);
  for (const s of snaps) await io.snapshot(s);
  if (Object.keys(changes).length > 0) await io.patch(pageId, changes);
  store.set(pageId, outcome.state);
  return decision.kind;
}

/**
 * Check one page after a pull: if a body different from our protected head arrived (and the
 * resolver did not see it, e.g. because our edit had already been pushed and then lost LWW),
 * merge it or flag a conflict, then write the result as a normal local edit.
 * Returns the decision taken (or null when there was nothing to do).
 */
export function reconcilePage(
  io: ReconcileIO,
  store: BodyStateStore,
  pageId: string,
): Promise<BodyDecision['kind'] | null> {
  // NB: the scope must be an async function that awaits (not `() => promise`), or Dexie loses
  // the transaction zone across nested native awaits and commits early.
  return io.transaction(async () => await reconcileInTx(io, store, pageId));
}

export interface SaveResult {
  /** The body actually stored (differs from the editor text if it had to be merged). */
  body: string;
  /** The editor text was merged with a body that changed underneath it. */
  merged: boolean;
  /** The editor text and the changed body overlapped: the other one is now in `conflict`. */
  conflict: boolean;
}

/**
 * Save editor text for a page. `from` is the body the editor text was derived from. Runs in
 * one transaction: first reconciles anything that arrived, then, if the stored body moved on
 * since the editor loaded it, three-way merges the editor text into it (against `from`), and
 * finally writes the body and its `bodyBase` and advances the page's BodyState.
 */
export function saveBody(
  io: ReconcileIO,
  store: BodyStateStore,
  pageId: string,
  text: string,
  from: string,
): Promise<SaveResult> {
  return io.transaction(async () => {
    await reconcileInTx(io, store, pageId);
    const rec = await io.get(pageId);
    if (!rec) throw new Error('page not found');
    let body = text;
    let merged = false;
    let conflict = false;
    const changes: Partial<RecordOf<'wikiPages'>> = {};
    if (rec.body !== from && rec.body !== text) {
      const r = merge3(from, text, rec.body);
      if (r.clean) {
        body = r.merged;
        merged = true;
      } else {
        conflict = true;
        const theirsId = io.newId();
        await io.snapshot({
          pageId,
          title: rec.title,
          body: rec.body,
          label: 'theirs',
          id: theirsId,
        });
        changes.conflict = {
          body: rec.body,
          revisionId: theirsId,
          detectedAt: new Date(io.now()).toISOString(),
        };
      }
    }
    if (body === rec.body && Object.keys(changes).length === 0) {
      if (!store.get(pageId)) store.set(pageId, acceptedState(rec.body, io.now()));
      return { body, merged, conflict };
    }
    const plan = planLocalSave(store.get(pageId), rec, body, io.now());
    changes.body = body;
    if (plan.bodyBase !== rec.bodyBase) changes.bodyBase = plan.bodyBase;
    await io.patch(pageId, changes);
    store.set(pageId, plan.state);
    return { body, merged, conflict };
  });
}

/**
 * Write a body chosen by the user to settle a conflict (keep mine / take theirs / combined).
 * Clears `conflict`. The result is declared as built on the stored body: replicas that
 * accepted the conflict record take it as is, or merge it with edits they made since.
 */
export function resolveConflict(
  io: ReconcileIO,
  store: BodyStateStore,
  pageId: string,
  body: string,
): Promise<void> {
  return io.transaction(async () => {
    const rec = await io.get(pageId);
    if (!rec) throw new Error('page not found');
    const now = io.now();
    let state: BodyState = {
      ...(store.get(pageId) ?? acceptedState(rec.body, now)),
      head: body,
      own: true,
      // Built on the stored body (which every replica that saw the conflict has accepted).
      base: hashText(rec.body),
      updatedAt: now,
    };
    state = withAncestor(state, rec.body, true);
    state = withAncestor(state, body, true);
    await io.patch(pageId, { body, bodyBase: state.base, conflict: null });
    store.set(pageId, state);
  });
}
