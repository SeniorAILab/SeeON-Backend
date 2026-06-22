// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// 백엔드 계층/DTO 경계를 warn-first로 기계 강제 (신규 의존성 0).
// 규약 SoT: ADR-064 · docs/rules/backend-architecture-lint-and-guard.md.
export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Stability deny-list (docs/rules/code-stability.md, ADR-014).
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      "prettier/prettier": ["error", { endOfLine: "auto" }],
    },
  },
  {
    // 현재 OFF인 규칙만 warn으로 추가. recommendedTypeChecked의 기존 error
    // (no-explicit-any/no-misused-promises/require-await)는 강등하지 않는다.
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'warn',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unnecessary-condition': 'warn',
    },
  },
  {
    // NodeNext '.js' import까지 잡으려 basename + globstar 패턴을 병기한다.
    files: ['src/**/*.controller.ts', 'src/**/controllers/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              group: ['*.repository.js', '**/*.repository.js', '**/repositories/**'],
              message:
                '컨트롤러는 Repository를 직접 import하지 않습니다. Service를 통해 접근하세요.',
            },
            {
              group: ['*.prisma.service.js', '**/prisma.service.js', '@prisma/client'],
              message:
                '컨트롤러는 Prisma(서비스/모델 타입)에 직접 의존하지 않습니다. Service를 통해 접근하세요.',
            },
            {
              group: ['**/adapters/**'],
              message: '컨트롤러는 구체 어댑터를 import하지 않습니다.',
            },
          ],
        },
      ],
    },
  },
  {
    // PrismaService 의존은 정상 → '!**/prisma.service.js'로 제외(전 레포지토리 오탐 방지).
    files: ['src/**/*.repository.ts', 'src/**/repositories/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'warn',
        {
          paths: [
            {
              name: '@nestjs/common',
              importNames: [
                'HttpException',
                'BadRequestException',
                'UnauthorizedException',
                'ForbiddenException',
                'NotFoundException',
                'ConflictException',
                'GoneException',
                'PayloadTooLargeException',
                'UnsupportedMediaTypeException',
                'UnprocessableEntityException',
                'InternalServerErrorException',
              ],
              message:
                '레포지토리는 HTTP 예외를 던지지 않습니다. null/도메인 결과를 반환하고 Service에서 매핑하세요.',
            },
          ],
          patterns: [
            {
              group: [
                '*.service.js',
                '**/*.service.js',
                '**/services/**',
                '!*.prisma.service.js',
                '!**/prisma.service.js',
                '!**/prisma/**',
              ],
              message: '레포지토리는 Service를 import하지 않습니다(PrismaService는 예외).',
            },
            {
              group: ['*.controller.js', '**/*.controller.js', '**/controllers/**'],
              message: '레포지토리는 Controller를 import하지 않습니다.',
            },
            {
              group: ['**/adapters/**'],
              message: '레포지토리는 외부 어댑터를 import하지 않습니다.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/**/*.service.ts', 'src/**/services/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'warn',
        {
          patterns: [
            {
              group: ['**/adapters/**'],
              message:
                '서비스는 구체 어댑터가 아닌 Port/토큰에 의존합니다. 어댑터는 Module에서 바인딩하세요.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'src/**/*.controller.ts',
      'src/**/controllers/**/*.ts',
      'src/**/*.service.ts',
      'src/**/services/**/*.ts',
    ],
    ignores: ['src/**/dto/**/*.dto.ts'],
    rules: {
      'no-restricted-syntax': [
        'warn',
        {
          selector: 'ExportNamedDeclaration > TSInterfaceDeclaration[id.name=/Dto$/]',
          message:
            'DTO interface는 도메인 dto/*.dto.ts 에 정의하세요 (controller/service 인라인 선언 금지).',
        },
        {
          selector: 'ExportNamedDeclaration > TSTypeAliasDeclaration[id.name=/Dto$/]',
          message:
            'DTO type은 도메인 dto/*.dto.ts 에 정의하세요 (controller/service 인라인 선언 금지).',
        },
      ],
    },
  },
);
