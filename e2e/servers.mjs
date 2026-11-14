// Starts the production build of Webfront for the end-to-end tests: two independent servers,
// each with its own fresh temporary DATA_DIR (A = the main instance, B = a "fresh account"
// for the import test). Never touches the dev server (5173/8787) or its data directory.
//
//   node e2e/servers.mjs            build first, then serve
//   E2E_SKIP_BUILD=1 node e2e/...   reuse an existing build
//
// Playwright's webServer runs this and stops it with SIGTERM; both servers are then stopped
// and their data directories deleted.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT_A = Number(process.env.E2E_PORT_A ?? 8799);
export const PORT_B = Number(process.env.E2E_PORT_B ?? 8798);

if (!process.env.E2E_SKIP_BUILD) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const children = [];
const dirs = [];
let stopping = false;

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

function start(port) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), `webfront-e2e-${port}-`));
  dirs.push(dataDir);
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
    if (!stopping) {
      process.stderr.write(`e2e server on ${port} exited with ${code}\n`);
      stop(1);
    }
  });
  children.push(child);
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

// B first: Playwright waits for A's URL, so A must come up last.
start(PORT_B);
await healthy(PORT_B);
start(PORT_A);
await healthy(PORT_A);
process.stdout.write(`e2e servers ready on ${PORT_A} and ${PORT_B}\n`);
