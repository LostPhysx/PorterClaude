// FROZEN (planner-authored). The list of npm packages exposed to the browser and the URLs
// they are served under. The web topic imports these exact URLs; adding an entry here is a
// cross-topic change -> ask before editing.
//
// Resolution: <repo>/node_modules/<packageDir> (npm workspaces hoist to the repo root),
// falling back to <repo>/web/node_modules/<packageDir> and <repo>/server/node_modules/...
// Missing directories are skipped with a warning instead of crashing.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { Express } from 'express';
import type { Logger } from './logger.js';
import type { Paths } from './paths.js';

export interface VendorRoute {
  /** url prefix, always under /vendor */
  route: string;
  /** path inside node_modules */
  packageDir: string;
}

export const VENDOR_ROUTES: VendorRoute[] = [
  // /vendor/bootstrap/css/bootstrap.min.css , /vendor/bootstrap/js/bootstrap.bundle.min.js
  { route: '/vendor/bootstrap', packageDir: 'bootstrap/dist' },
  // /vendor/bootstrap-icons/bootstrap-icons.css (+ fonts/ resolved relatively)
  { route: '/vendor/bootstrap-icons', packageDir: 'bootstrap-icons/font' },
  // /vendor/jquery/jquery.min.js
  { route: '/vendor/jquery', packageDir: 'jquery/dist' },
  // /vendor/xterm/css/xterm.css , /vendor/xterm/lib/xterm.js  (UMD only; no .mjs is published)
  { route: '/vendor/xterm', packageDir: '@xterm/xterm' },
  // /vendor/xterm-addon-fit/addon-fit.js  (UMD only; no .mjs is published)
  { route: '/vendor/xterm-addon-fit', packageDir: '@xterm/addon-fit/lib' },
  // /vendor/xterm-addon-web-links/addon-web-links.js
  { route: '/vendor/xterm-addon-web-links', packageDir: '@xterm/addon-web-links/lib' },
  // /vendor/golden-layout/esm/index.js , /vendor/golden-layout/css/*.css
  // (2.6.0 ships no dist/bundle/; the ESM graph needs the extensions:['js'] option below)
  { route: '/vendor/golden-layout', packageDir: 'golden-layout/dist' },
];

export interface VendorMountResult {
  route: string;
  dir: string | null;
  mounted: boolean;
}

/** Last mount result, so GET /api/settings/vendor can report the real state. */
let lastMountResults: VendorMountResult[] | null = null;

/**
 * Mount every VENDOR_ROUTES entry with express.static (immutable-ish caching:
 * maxAge 1h, etag on). Returns what was mounted so /api/settings/vendor can report it.
 */
export function mountVendorRoutes(app: Express, paths: Paths, log: Logger): VendorMountResult[] {
  const results: VendorMountResult[] = VENDOR_ROUTES.map(({ route, packageDir }) => {
    const dir = resolveVendorDir(paths, packageDir);
    if (!dir) {
      log.warn({ route, packageDir }, 'vendor package not found; route not mounted');
      return { route, dir: null, mounted: false };
    }
    // extensions: ['js'] lets the browser resolve golden-layout's extensionless ESM
    // specifiers (dist/esm/index.js does `export * from './ts/config/config'`), so
    // GET /vendor/golden-layout/esm/ts/config/config is answered with config.js and the
    // right text/javascript content type. fallthrough keeps unmatched /vendor/** GETs
    // falling through to the 404 handler rather than the SPA index.html.
    app.use(route, express.static(dir, {
      maxAge: '1h', etag: true, fallthrough: true, index: false, extensions: ['js'],
    }));
    return { route, dir, mounted: true };
  });
  lastMountResults = results;
  log.info({ mounted: results.filter((r) => r.mounted).length, total: results.length }, 'vendor routes mounted');
  return results;
}

/** What mountVendorRoutes produced (or a fresh resolution when it has not run yet). */
export function vendorMountResults(paths: Paths): VendorMountResult[] {
  if (lastMountResults) return lastMountResults;
  return VENDOR_ROUTES.map(({ route, packageDir }) => {
    const dir = resolveVendorDir(paths, packageDir);
    return { route, dir, mounted: dir !== null };
  });
}

/** Resolve <packageDir> against the candidate node_modules roots. */
export function resolveVendorDir(paths: Paths, packageDir: string): string | null {
  const roots = [
    paths.nodeModules,
    path.join(paths.repoRoot, 'web', 'node_modules'),
    path.join(paths.serverRoot, 'node_modules'),
  ];
  for (const root of roots) {
    const candidate = path.join(root, ...packageDir.split('/'));
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // try the next root
    }
  }
  return null;
}
