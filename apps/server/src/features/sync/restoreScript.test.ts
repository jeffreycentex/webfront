import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Runs deploy/test/restore-epoch.test.sh: the restore-marker part of deploy/restore.sh against
 * temporary SQLite files. Skipped where bash or the sqlite3 CLI is missing.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const has = (cmd: string) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;

describe('deploy/restore.sh restore marker', () => {
  it.skipIf(!has('bash') || !has('sqlite3'))('passes its shell tests', () => {
    const r = spawnSync('bash', [path.join(root, 'deploy/test/restore-epoch.test.sh')], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(r.stderr + r.stdout).toContain('all restore-epoch tests passed');
    expect(r.status).toBe(0);
  });
});
