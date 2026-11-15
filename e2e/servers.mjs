// Starts the production build of Webfront for the end-to-end tests: two independent servers,
// each with its own fresh temporary DATA_DIR (A = the main instance, B = a "fresh account"
// for the import test). Never touches the dev server (5173/8787) or its data directory.
//
//   node e2e/servers.mjs            build first, then serve
//   E2E_SKIP_BUILD=1 node e2e/...   reuse an existing build
//
// Playwright's webServer runs this and stops it with SIGTERM; both servers are then stopped
// and their data directories deleted.
//
// Control endpoint (127.0.0.1:E2E_CONTROL_PORT, default 8797) for restore.spec.ts, doing what
// the deploy scripts do on the real container:
//   POST /backup?server=A               deploy/backup.sh on that server's DATA_DIR -> { id }
//   POST /restore?server=A&id=<id>      stop the server, put the backup's webfront.db and
//                                       attachments in place, write a fresh sync epoch with
//                                       restore.sh's own `write_epoch`, start it again
// Needs bash and the sqlite3 CLI (as the deploy scripts do).
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT_A = Number(process.env.E2E_PORT_A ?? 8799);
export const PORT_B = Number(process.env.E2E_PORT_B ?? 8798);
export const CONTROL_PORT = Number(process.env.E2E_CONTROL_PORT ?? 8797);

if (!process.env.E2E_SKIP_BUILD) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const children = [];
const dirs = [];
let stopping = false;
/** port -> { child, dataDir } of the running servers. */
const servers = new Map();
/** Children being restarted on purpose (their exit is not a failure). */
const restarting = new Set();

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => {
    for (const c of children) c.kill('SIGKILL');
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    process.exit(code);
  }, 1500).unref();
  // Exit as soon as every child is gone.
  let alive = children.length;
  if (alive === 0) finish();
  for (const c of children) c.once('exit', () => --alive === 0 && finish());
  function finish() {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    process.exit(code);
  }
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));

function start(port, existingDir) {
  const dataDir = existingDir ?? mkdtempSync(path.join(os.tmpdir(), `webfront-e2e-${port}-`));
  if (!existingDir) dirs.push(dataDir);
  const child = spawn(process.execPath, [path.join(root, 'apps/server/dist/index.js')], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: `http://localhost:${port}`,
      WEB_DIST_DIR: path.join(root, 'apps/web/dist'),
      LOG_LEVEL: 'warn',
      TRUST_PROXY: 'false',
    },
  });
  child.once('exit', (code) => {
    const i = children.indexOf(child);
    if (i >= 0) children.splice(i, 1);
    if (restarting.has(child)) return;
    if (!stopping) {
      process.stderr.write(`e2e server on ${port} exited with ${code}\n`);
      stop(1);
    }
  });
  children.push(child);
  servers.set(port, { child, dataDir });
}

async function healthy(port) {
  for (let i = 0; i < 200; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server on ${port} did not become healthy`);
}

/* ------------------------------------------------------------- backup / restore control */

const backups = new Map(); // id -> archive path

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function portOf(name) {
  if (name === 'A') return PORT_A;
  if (name === 'B') return PORT_B;
  throw new Error(`unknown server ${name}`);
}

/** deploy/backup.sh against the server's data directory (online backup while it runs). */
function backup(port) {
  const { dataDir } = servers.get(port);
  const backupDir = path.join(dataDir, 'e2e-backups');
  const out = run('bash', [path.join(root, 'deploy/backup.sh')], {
    DATA_DIR: dataDir,
    BACKUP_DIR: backupDir,
  });
  const archive = /wrote (\S+\.tar\.gz)/.exec(out)?.[1];
  if (!archive || !existsSync(archive)) throw new Error(`backup.sh wrote no archive: ${out}`);
  const id = String(backups.size + 1);
  backups.set(id, archive);
  return { id };
}

/** What webfront-restore does, minus root, systemd and archive validation. */
async function restore(port, id) {
  const archive = backups.get(id);
  if (!archive) throw new Error(`unknown backup ${id}`);
  const { child, dataDir } = servers.get(port);
  restarting.add(child);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await exited;
  restarting.delete(child);

  const stage = mkdtempSync(path.join(dataDir, '.restore-'));
  run('tar', ['-xzf', archive, '-C', stage]);
  const aside = path.join(dataDir, `pre-restore-${Date.now()}`);
  mkdirSync(aside);
  for (const f of ['webfront.db', 'webfront.db-wal', 'webfront.db-shm', 'attachments']) {
    if (existsSync(path.join(dataDir, f))) renameSync(path.join(dataDir, f), path.join(aside, f));
  }
  renameSync(path.join(stage, 'webfront.db'), path.join(dataDir, 'webfront.db'));
  if (existsSync(path.join(stage, 'attachments'))) {
    renameSync(path.join(stage, 'attachments'), path.join(dataDir, 'attachments'));
  } else mkdirSync(path.join(dataDir, 'attachments'));
  rmSync(stage, { recursive: true, force: true });
  // The exact function restore.sh runs on the restored database before starting the service.
  const epoch = run('bash', [
    '-c',
    '. "$1"; write_epoch "$2"',
    'restore-epoch',
    path.join(root, 'deploy/restore.sh'),
    path.join(dataDir, 'webfront.db'),
  ]).trim();

  start(port, dataDir);
  await healthy(port);
  return { epoch };
}

const control = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  (async () => {
    const port = portOf(url.searchParams.get('server') ?? '');
    if (url.pathname === '/backup') return backup(port);
    if (url.pathname === '/restore') return restore(port, url.searchParams.get('id') ?? '');
    throw new Error(`unknown action ${url.pathname}`);
  })().then(
    (body) => reply(200, body),
    (err) => reply(500, { error: String(err?.message ?? err) }),
  );
});
control.on('error', (err) => {
  // Only restore.spec.ts needs it: report and keep serving the app for the other specs.
  process.stderr.write(`e2e control endpoint unavailable on ${CONTROL_PORT}: ${err.message}\n`);
});
control.listen(CONTROL_PORT, '127.0.0.1');
process.on('exit', () => control.close());

// B first: Playwright waits for A's URL, so A must come up last.
start(PORT_B);
await healthy(PORT_B);
start(PORT_A);
await healthy(PORT_A);
process.stdout.write(`e2e servers ready on ${PORT_A} and ${PORT_B}\n`);
