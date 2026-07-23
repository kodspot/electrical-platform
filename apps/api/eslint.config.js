'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const prettierConfig = require('eslint-config-prettier');

module.exports = [
  {
    ignores: ['public/**', 'node_modules/**']
  },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', 'scripts/**/*.js', 'scenarios/**/*.js', '*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node
      }
    },
    rules: {
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
    }
  },
  prettierConfig
];
