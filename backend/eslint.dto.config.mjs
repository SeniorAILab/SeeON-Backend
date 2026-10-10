// @ts-check
import tseslint from 'typescript-eslint';
import architecture, { productionFiles } from './eslint/architecture.mjs';

export default [
  {
    files: productionFiles,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { architecture },
    rules: { 'architecture/boundaries': 'error' },
  },
];
