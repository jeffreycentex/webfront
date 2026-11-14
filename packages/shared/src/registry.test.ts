import { describe, expect, it } from 'vitest';
import { newClientId, newId, uuidv7Timestamp } from './ids.js';
import { HLC_PATTERN, HlcClock } from './hlc.js';
import { applyLocalEdit } from './record.js';
import {
  COLLECTION_NAMES,
  SERVER_OWNED_COLLECTIONS,
  WRITABLE_COLLECTIONS,
  collections,
  isValidRecordId,
  parseRecord,
  validateFieldValue,
  type FieldsInput,
} from './registry.js';
import { pullQuerySchema, pushRequestSchema } from './api/sync.js';
import { colourForLabel, COLOUR_KEYS } from './colours.js';
import { coreSettings, readSetting } from './collections/settings.js';

describe('ids', () => {
  it('creates valid, time-ordered UUIDv7s and client ids', () => {
    const id = newId(1_700_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidv7Timestamp(id)).toBe(1_700_000_000_000);
    expect(newId(1_700_000_000_001) > id).toBe(true);
    expect(newClientId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('collection registry', () => {
  it('lists every collection exactly once, split by writability', () => {
    expect(COLLECTION_NAMES).toHaveLength(12);
    expect([...WRITABLE_COLLECTIONS, ...SERVER_OWNED_COLLECTIONS].sort()).toEqual(
      [...COLLECTION_NAMES].sort(),
    );
    expect(SERVER_OWNED_COLLECTIONS.sort()).toEqual(['calendarEvents', 'serviceStatuses']);
    for (const name of COLLECTION_NAMES) expect(collections[name].name).toBe(name);
  });

  it('builds a full record schema that fills defaults', () => {
    const clock = new HlcClock(newClientId());
    const id = newId();
    const input: FieldsInput<'bookmarks'> = {
      url: 'https://example.com',
      title: 'Example',
      sortKey: 'a0',
    };
    const fields = collections.bookmarks.fields.parse(input);
    const { record } = applyLocalEdit(
      undefined,
      id,
      fields,
      clock.tick(),
      new Date().toISOString(),
    );
    const parsed = parseRecord('bookmarks', record);
    expect(parsed).toMatchObject({
      id,
      tags: [],
      isService: false,
      serviceCheck: null,
      deleted: false,
    });
    expect(Object.values(parsed.clocks).every((c) => HLC_PATTERN.test(c))).toBe(true);
  });

  it('validates individual field values', () => {
    expect(validateFieldValue('postits', 'colour', 'teal')).toEqual({ ok: true, value: 'teal' });
    expect(validateFieldValue('postits', 'colour', 'mauve').ok).toBe(false);
    expect(validateFieldValue('postits', 'nope', 1).ok).toBe(false);
    expect(validateFieldValue('postits', 'deleted', true).ok).toBe(true);
    expect(validateFieldValue('postits', 'constructor', 1).ok).toBe(false);
    const check = validateFieldValue('bookmarks', 'serviceCheck', {
      type: 'tcp',
      host: 'nas',
      port: 22,
    });
    expect(check).toEqual({
      ok: true,
      value: { type: 'tcp', host: 'nas', port: 22, timeoutMs: 5000 },
    });
  });

  it('validates ids by idKind', () => {
    expect(isValidRecordId('tasks', newId())).toBe(true);
    expect(isValidRecordId('tasks', 'search.engine')).toBe(false);
    expect(isValidRecordId('settings', 'search.engine')).toBe(true);
    expect(isValidRecordId('settings', newId())).toBe(false);
  });
});

describe('sync protocol schemas', () => {
  it('parses pull queries from strings with defaults and limits', () => {
    expect(pullQuerySchema.parse({})).toEqual({ since: 0, limit: 500 });
    expect(pullQuerySchema.parse({ since: '42', limit: '10' })).toEqual({ since: 42, limit: 10 });
    expect(pullQuerySchema.safeParse({ limit: '100000' }).success).toBe(false);
  });

  it('rejects pushes to unknown collections', () => {
    const ok = pushRequestSchema.safeParse({ clientId: newClientId(), changes: [] });
    expect(ok.success).toBe(true);
    const bad = pushRequestSchema.safeParse({
      clientId: newClientId(),
      changes: [
        { collection: 'nope', id: newId(), createdAt: new Date().toISOString(), fields: {} },
      ],
    });
    expect(bad.success).toBe(false);
  });
});

describe('colours and settings', () => {
  it('maps labels to palette colours deterministically', () => {
    expect(COLOUR_KEYS).toHaveLength(12);
    expect(colourForLabel('Homelab')).toBe(colourForLabel(' homelab '));
    expect(COLOUR_KEYS).toContain(colourForLabel('x'));
  });

  it('falls back to defaults for invalid setting values', () => {
    expect(readSetting(coreSettings.theme, 'dark')).toBe('dark');
    expect(readSetting(coreSettings.theme, 'purple')).toBe('system');
    expect(readSetting(coreSettings.searchEngine, undefined).urlTemplate).toContain('%s');
  });
});
