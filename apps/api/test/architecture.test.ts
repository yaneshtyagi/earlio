import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []; });
const imports = (f: string) => [...readFileSync(f, 'utf8').matchAll(/from '(\.[^']*)'/g)].map((m) => m[1]!);
const resolve = (f: string, spec: string) => relative(SRC, join(f, '..', spec));

describe('module boundaries', () => {
  it('a module never imports another module\'s HTTP routes', () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, 'modules'))) {
      if (f.endsWith('modules/index.ts')) continue;
      const own = relative(join(SRC, 'modules'), f).split('/')[0];
      for (const s of imports(f)) { const r = resolve(f, s); const m = r.match(/^modules\/([^/]+)\/routes$/); if (m && m[1] !== own) bad.push(`${relative(SRC, f)} -> ${r}`); }
    }
    expect(bad).toEqual([]);
  });
  it('the kernel does not depend on feature modules', () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, 'kernel'))) for (const s of imports(f)) { const r = resolve(f, s); if (r.startsWith('modules/') || r.startsWith('demo/')) bad.push(`${relative(SRC, f)} -> ${r}`); }
    expect(bad).toEqual([]);
  });
  it('no module reaches into the demo tooling', () => {
    const bad: string[] = [];
    for (const f of files(join(SRC, 'modules')).filter((x) => !x.endsWith('modules/index.ts'))) for (const s of imports(f)) if (resolve(f, s).startsWith('demo/')) bad.push(`${relative(SRC, f)}`);
    expect(bad).toEqual([]);
  });
  it('the web app only talks to the API through the generated client', () => {
    const web = join(SRC, '..', '..', 'web', 'src');
    const bad = files2(web).filter((f) => /from '(\.\.?\/)+api\/src|@earlio\/api/.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
function files2(d: string): string[] { return readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files2(p) : /\.tsx?$/.test(p) ? [p] : []; }); }
