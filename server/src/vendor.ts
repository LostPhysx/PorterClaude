// FROZEN (planner-authored). The list of npm packages exposed to the browser and the URLs
// they are served under. The web topic imports these exact URLs; adding an entry here is a
// cross-topic change -> ask before editing.
//
// Resolution: <repo>/node_modules/<packageDir> (npm workspaces hoist to the repo root),
// falling back to <repo>/web/node_modules/<packageDir> and <repo>/server/node_modules/...
// Missing directories are skipped with a warning instead of crashing.
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
  // /vendor/xterm/css/xterm.css , /vendor/xterm/lib/xterm.js (+ xterm.mjs)
  { route: '/vendor/xterm', packageDir: '@xterm/xterm' },
  // /vendor/xterm-addon-fit/addon-fit.js (+ addon-fit.mjs)
  { route: '/vendor/xterm-addon-fit', packageDir: '@xterm/addon-fit/lib' },
  // /vendor/xterm-addon-web-links/addon-web-links.js
  { route: '/vendor/xterm-addon-web-links', packageDir: '@xterm/addon-web-links/lib' },
  // /vendor/golden-layout/bundle/esm/golden-layout.js , /vendor/golden-layout/css/*.css
  { route: '/vendor/golden-layout', packageDir: 'golden-layout/dist' },
];

export interface VendorMountResult {
  route: string;
  dir: string | null;
  mounted: boolean;
}

/**
 * Mount every VENDOR_ROUTES entry with express.static (immutable-ish caching:
 * maxAge 1h, etag on). Returns what was mounted so /api/vendor/manifest can report it.
 * TODO(B1)
 */
export function mountVendorRoutes(app: Express, paths: Paths, log: Logger): VendorMountResult[] {
  throw new Error('TODO(B1): implement mountVendorRoutes');
}

/** Resolve <packageDir> against the candidate node_modules roots. TODO(B1) */
export function resolveVendorDir(paths: Paths, packageDir: string): string | null {
  throw new Error('TODO(B1)');
}
