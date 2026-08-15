#!/usr/bin/env node
// Planner-authored, complete. Headless smoke test for the web workspace - no browser.
//   npm run verify --workspace web
// Checks:
//   1. every /vendor/... URL referenced by index.html resolves to a real file in node_modules
//      (through the FROZEN route -> packageDir map that mirrors server/src/vendor.ts)
//   2. every local /js/... and /css/... URL referenced by index.html exists on disk
//   3. every ES import specifier used by web/public/js/*.js resolves (relative + /vendor/)
//   4. every js module parses (node --check)
// Exit code 0 = all good, 1 = at least one failure. node_modules missing -> vendor checks
// are reported as SKIP, not failures.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const repoRoot = path.resolve(webRoot, '..');
const publicDir = path.join(webRoot, 'public');

/** FROZEN mirror of VENDOR_ROUTES in server/src/vendor.ts */
const VENDOR_ROUTES = [
  ['/vendor/bootstrap', 'bootstrap/dist'],
  ['/vendor/bootstrap-icons', 'bootstrap-icons/font'],
  ['/vendor/jquery', 'jquery/dist'],
  ['/vendor/xterm', '@xterm/xterm'],
  ['/vendor/xterm-addon-fit', '@xterm/addon-fit/lib'],
  ['/vendor/xterm-addon-web-links', '@xterm/addon-web-links/lib'],
  ['/vendor/golden-layout', 'golden-layout/dist'],
];

const nodeModuleRoots = [path.join(repoRoot, 'node_modules'), path.join(webRoot, 'node_modules')];
const haveNodeModules = nodeModuleRoots.some((r) => existsSync(r));

let failures = 0;
let skipped = 0;
const ok = (m) => console.log(`  ok    ${m}`);
const skip = (m) => { skipped++; console.log(`  skip  ${m}`); };
const fail = (m) => { failures++; console.log(`  FAIL  ${m}`); };

function resolveVendorUrl(url) {
  const clean = url.split('?')[0];
  const entry = VENDOR_ROUTES.find(([route]) => clean === route || clean.startsWith(route + '/'));
  if (!entry) return { kind: 'unknown' };
  const rel = clean.slice(entry[0].length).replace(/^\//, '');
  for (const root of nodeModuleRoots) {
    const p = path.join(root, entry[1], rel);
    if (existsSync(p)) return { kind: 'found', path: p };
  }
  return { kind: 'missing', tried: nodeModuleRoots.map((r) => path.join(r, entry[1], rel)) };
}

function checkUrl(url, origin) {
  if (url.startsWith('/vendor/')) {
    if (!haveNodeModules) return skip(`${url} (no node_modules yet)`);
    const r = resolveVendorUrl(url);
    if (r.kind === 'found') return ok(`${url}`);
    if (r.kind === 'unknown') return fail(`${url} is not covered by VENDOR_ROUTES (${origin})`);
    return fail(`${url} not found in node_modules (${origin})`);
  }
  if (url.startsWith('/')) {
    const p = path.join(publicDir, url.split('?')[0]);
    return existsSync(p) ? ok(url) : fail(`${url} missing under web/public (${origin})`);
  }
  return skip(`${url} (external, ignored)`);
}

function listFiles(dir, ext) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((f) => statSync(f).isFile() && f.endsWith(ext));
}

console.log('index.html asset references');
const html = readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const refs = new Set();
for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) refs.add(m[1]);
for (const url of refs) {
  if (url.startsWith('#') || url.startsWith('data:') || url.startsWith('http')) continue;
  checkUrl(url, 'index.html');
}

console.log('\nES module imports');
const jsFiles = listFiles(path.join(publicDir, 'js'), '.js');
if (jsFiles.length === 0) fail('no modules found in web/public/js');
for (const file of jsFiles) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/(?:^|\s)(?:import|export)[^;]*?from\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    const origin = path.relative(repoRoot, file);
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const p = path.resolve(path.dirname(file), spec);
      existsSync(p) ? ok(`${origin} -> ${spec}`) : fail(`${origin} -> ${spec} does not exist`);
    } else if (spec.startsWith('/')) {
      checkUrl(spec, origin);
    } else {
      fail(`${origin} -> bare specifier "${spec}" cannot work in a browser (no bundler)`);
    }
  }
}

console.log('\nsyntax check (node --check)');
for (const file of jsFiles.concat(listFiles(path.join(webRoot, 'tools'), '.mjs'))) {
  const rel = path.relative(repoRoot, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    ok(rel);
  } catch (err) {
    const msg = String(err.stderr || err.message).split('\n').slice(0, 4).join(' ');
    fail(`${rel}: ${msg}`);
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} - ${failures} failure(s), ${skipped} skipped`);
process.exit(failures === 0 ? 0 : 1);
