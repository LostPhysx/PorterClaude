// Flat ESLint config (ESLint 9). Minimal: recommended JS + TS rules, no type-aware linting
// (keeps lint fast and avoids a second tsconfig program). `npm run typecheck` is the real gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  { ignores: ['**/dist/**', '**/node_modules/**', 'data/**', 'web/public/vendor/**'] },
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
    files: ['web/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { window: 'readonly', document: 'readonly', console: 'readonly', fetch: 'readonly', $: 'readonly', WebSocket: 'readonly', localStorage: 'readonly' } }
  }
];
