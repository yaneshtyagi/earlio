import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';

function binDir(): string {
  const plat = `${process.platform}-${process.arch}`;
  let dir = dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, 'node_modules', '@embedded-postgres', plat, 'native', 'bin');
    if (existsSync(join(cand, 'postgres'))) return cand;
    dir = dirname(dir);
  }
  throw new Error('No embedded Postgres binaries installed for this platform (npm i -D embedded-postgres).');
}

const freePort = () =>
  new Promise<number>((res, rej) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = (s.address() as any).port; s.close(() => res(p)); });
    s.on('error', rej);
  });

/** Postgres refuses to run as root; in root containers run it as an unprivileged user. */
function runAs(cmd: string, args: string[]): [string, string[]] {
  if (process.getuid?.() === 0) {
    const user = process.env.EARLIO_PG_USER ?? 'pgrun';
    return ['runuser', ['-u', user, '--', cmd, ...args]];
  }
  return [cmd, args];
}

function chownTree(dir: string) {
  if (process.getuid?.() !== 0) return;
  const u = spawnSync('id', ['-u', process.env.EARLIO_PG_USER ?? 'pgrun']);
  const uid = Number(u.stdout.toString().trim());
  const gid = Number(spawnSync('id', ['-g', process.env.EARLIO_PG_USER ?? 'pgrun']).stdout.toString().trim());
  const walk = (p: string) => { chownSync(p, uid, gid); if (statSync(p).isDirectory()) readdirSync(p).forEach((c) => walk(join(p, c))); };
  walk(dir);
}

export interface RunningPostgres {
  port: number;
  adminUrl: string; // superuser (migrations, test tamper), database "earlio"
  appUrl: string;   // application role, subject to RLS
  baseAdminUrl: (db: string) => string;
  stop: () => Promise<void>;
}

export async function startPostgres(opts: { persistentDir?: string } = {}): Promise<RunningPostgres> {
  const bin = binDir();
  const dataDir = opts.persistentDir ? resolve(opts.persistentDir) : mkdtempSync(join(tmpdir(), 'earlio-pg-'));
  mkdirSync(dataDir, { recursive: true });
  chownTree(dataDir);
  const fresh = !existsSync(join(dataDir, 'PG_VERSION'));
  if (fresh) {
    const [c, a] = runAs(join(bin, 'initdb'), ['-D', dataDir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8', '--no-locale']);
    const r = spawnSync(c, a, { encoding: 'utf8' });
    if (r.status !== 0) throw new Error('initdb failed: ' + r.stderr + r.stdout);
  }
  const port = await freePort();
  const [c, a] = runAs(join(bin, 'postgres'), [
    '-D', dataDir, '-p', String(port), '-c', 'listen_addresses=127.0.0.1', '-c', `unix_socket_directories=${dataDir}`,
    '-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off', '-c', 'max_connections=200',
  ]);
  const proc: ChildProcess = spawn(c, a, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (d) => { stderr += d.toString(); });
  const base = (db: string) => `postgres://postgres@127.0.0.1:${port}/${db}`;
  for (let i = 0; i < 100; i++) {
    try {
      const client = new pg.Client({ connectionString: base('postgres') });
      await client.connect();
      const has = await client.query("select 1 from pg_database where datname = 'earlio'");
      if (has.rowCount === 0) await client.query('create database earlio');
      await client.end();
      break;
    } catch {
      if (proc.exitCode !== null) throw new Error('postgres exited: ' + stderr);
      await new Promise((r) => setTimeout(r, 100));
      if (i === 99) throw new Error('postgres did not start: ' + stderr);
    }
  }
  return {
    port,
    adminUrl: base('earlio'),
    appUrl: `postgres://earlio_app:earlio_app@127.0.0.1:${port}/earlio`,
    baseAdminUrl: base,
    stop: () =>
      new Promise<void>((res) => {
        if (proc.exitCode !== null) return res();
        proc.once('exit', () => res());
        // runuser does not forward signals: signal the postmaster itself (pid is the first line of postmaster.pid).
        let pid = proc.pid!;
        try { pid = Number(readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n')[0]); } catch { /* fall back */ }
        try { process.kill(pid, 'SIGINT'); } catch { /* already gone */ } // fast shutdown
        setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 8000).unref();
      }),
  };
}
