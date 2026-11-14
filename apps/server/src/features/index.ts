import type { App, AppContext } from '../context.js';
import * as attachments from './attachments/index.js';
import * as auth from './auth/index.js';
import * as calendar from './calendar/index.js';
import * as favicons from './favicons/index.js';
import * as services from './services/index.js';
import * as sync from './sync/index.js';

/**
 * Central list of server features (Task 1 file; feature tasks do not edit it).
 * Order matters: auth installs global /api middleware and the auth guard, sync installs the
 * record store; both must run before features that use them.
 */
export interface ServerFeature {
  name: string;
  register(app: App, ctx: AppContext): void | Promise<void>;
}

export const serverFeatures: readonly ServerFeature[] = [
  { name: 'auth', register: auth.register },
  { name: 'sync', register: sync.register },
  { name: 'calendar', register: calendar.register },
  { name: 'services', register: services.register },
  { name: 'favicons', register: favicons.register },
  { name: 'attachments', register: attachments.register },
];
