/**
 * @webfront/shared — the contract between server and web.
 * Import from the package root only: `import { collections, mergeRecord } from '@webfront/shared'`.
 */
export * from './ids.js';
export * from './hlc.js';
export * from './colours.js';
export * from './record.js';
export * from './sortKey.js';
export * from './urls.js';

export * from './collections/common.js';
export * from './collections/bookmarks.js';
export * from './collections/notes.js';
export * from './collections/shopping.js';
export * from './collections/wiki.js';
export * from './collections/calendar.js';
export * from './collections/services.js';
export * from './collections/settings.js';
export * from './registry.js';

export * from './api/common.js';
export * from './api/sync.js';
export * from './api/auth.js';
