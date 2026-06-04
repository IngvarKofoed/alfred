import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { module: 'readonly', require: 'readonly', __dirname: 'readonly', process: 'readonly' },
    },
  },
  {
    // Node-run ESM build scripts (e.g. the chrome-extension esbuild build).
    files: ['**/build.js'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
)
