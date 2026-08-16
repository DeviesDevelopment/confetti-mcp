import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsparser from '@typescript-eslint/parser'

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // TypeScript (via `tsc --noEmit`, also run by `npm run lint`) already catches genuine
      // undefined-variable errors and understands ambient/TS-only globals (NodeJS, fetch, etc.)
      // that base ESLint's no-undef does not. Disabling it here avoids false positives.
      'no-undef': 'off',
    },
  },
  { ignores: ['dist/**', 'node_modules/**'] },
]
