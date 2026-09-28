/**
 * Copyright (c) 2026 OpenNVR
 * This file is part of OpenNVR.
 * 
 * OpenNVR is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * OpenNVR is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU Affero General Public License
 * along with OpenNVR.  If not, see <https://www.gnu.org/licenses/>.
 */

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig } from 'eslint/config'
import tseslint from 'typescript-eslint'

// Every rule in the TypeScript block starts life as a warning. The .ts/.tsx
// source was never linted before, so turning these on as errors would fail
// CI on day one; warnings make the debt visible without blocking anyone.
// Rules get promoted to errors one at a time as the code is cleaned up.
const asWarnings = (configs) =>
  configs.map((c) => ({
    ...c,
    rules: Object.fromEntries(
      Object.entries(c.rules ?? {}).map(([name, value]) => [
        name,
        Array.isArray(value)
          ? (value[0] === 'off' || value[0] === 0 ? value : ['warn', ...value.slice(1)])
          : (value === 'off' || value === 0 ? value : 'warn'),
      ]),
    ),
  }))

export default defineConfig([
  { ignores: ['dist', 'dev-dist'] },
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    extends: asWarnings([
      ...tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ]),
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
  },
  {
    // Promoted: zero violations when TS linting was switched on, and a hook
    // called conditionally is a crash waiting for the branch that skips it.
    files: ['src/**/*.{ts,tsx}'],
    rules: { 'react-hooks/rules-of-hooks': 'error' },
  },
])

