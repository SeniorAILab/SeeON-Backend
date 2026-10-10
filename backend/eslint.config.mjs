// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import architecture, { productionFiles } from './eslint/architecture.mjs';

export default tseslint.config(
  { ignores: ['eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'error',
    },
  },
  {
    files: productionFiles,
    plugins: { architecture },
    rules: { 'architecture/boundaries': 'error' },
  },
  {
    // Retained lexical declaration convention, separate from semantic boundaries.
    files: [
      'src/**/*.controller.ts',
      'src/**/controllers/**/*.ts',
      'src/**/*.service.ts',
      'src/**/services/**/*.ts',
    ],
    ignores: ['src/**/dto/**/*.dto.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportNamedDeclaration > TSInterfaceDeclaration[id.name=/Dto$/]',
          message: 'DTO interfaces belong in domain dto/*.dto.ts files.',
        },
        {
          selector: 'ExportNamedDeclaration > TSTypeAliasDeclaration[id.name=/Dto$/]',
          message: 'DTO aliases belong in domain dto/*.dto.ts files.',
        },
      ],
    },
  },
);
