// Flat ESLint config (ESLint 9). Minimal: recommended JS + TS rules, no type-aware linting
// (keeps lint fast and avoids a second tsconfig program). `npm run typecheck` is the real gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  // `data*/**` (not just `data/**`): every DATA_DIR inside the checkout must start with
  // `data` (docs/DEPLOYMENT.md, .gitignore, .dockerignore all key off that prefix), and
  // those directories hold runtime state plus ad-hoc QA scratch scripts — never sources.
  { ignores: ['**/dist/**', '**/node_modules/**', 'data*/**', 'web/public/vendor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off'
    }
  },
  {
    // Browser globals for the bundler-less web UI (frontend.md 1.1). Keeping this map in
    // sync with what the UI actually uses is what lets web/public/js/*.js drop their
    // per-file `/* global ... */` pragmas.
    files: ['web/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        window: 'readonly', document: 'readonly', console: 'readonly', fetch: 'readonly',
        WebSocket: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly',
        location: 'readonly', navigator: 'readonly', history: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly',
        setInterval: 'readonly', clearInterval: 'readonly',
        requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly',
        matchMedia: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
        Blob: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        CustomEvent: 'readonly', Event: 'readonly', HTMLElement: 'readonly',
        // third-party globals loaded from /vendor/** by index.html
        $: 'readonly', jQuery: 'readonly', bootstrap: 'readonly',
        Terminal: 'readonly', FitAddon: 'readonly', WebLinksAddon: 'readonly'
      }
    }
  },
  {
    // Node tooling that ships with the web workspace (web/tools/verify-assets.mjs).
    files: ['web/tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { console: 'readonly', process: 'readonly', URL: 'readonly', Buffer: 'readonly' }
    }
  }
];
