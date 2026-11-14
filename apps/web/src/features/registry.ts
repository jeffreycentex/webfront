import bookmarks from './bookmarks/index';
import calendar from './calendar/index';
import dashboard from './dashboard/index';
import postits from './postits/index';
import settings from './settings/index';
import shopping from './shopping/index';
import tasks from './tasks/index';
import wiki from './wiki/index';
import type { FeatureDescriptor } from './types';

/**
 * Central feature list (Task 1 file; feature tasks do not edit it — they only edit inside
 * their own folder). Consumers should use `useFeatures()` rather than importing this, so
 * features like the dashboard can read the registry without an import cycle.
 */
export const features: readonly FeatureDescriptor[] = [
  dashboard,
  bookmarks,
  postits,
  tasks,
  shopping,
  calendar,
  wiki,
  settings,
];
