/* eslint-env node */
'use strict';

module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'prettier',
  ],
  env: { node: true, es2022: true },
  ignorePatterns: ['out/', 'node_modules/', '*.js', '*.mjs', 'bin/'],
  rules: {
    '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-var-requires': 'warn',
    'no-useless-escape': 'warn',
    'no-constant-condition': 'warn',
    'no-case-declarations': 'warn',
  },
};
