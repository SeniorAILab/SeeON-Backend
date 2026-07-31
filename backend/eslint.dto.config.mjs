// @ts-check
// dto:check 전용 경량 ESLint config — 구 check-dto-contracts.mjs(정규식 스캐너)를
// AST 기반으로 대체한다. 타입정보(projectService) 없이 선택자만 쓰므로 수 초 안에 끝난다.
// 메인 eslint.config.mjs와 이 DTO 전용 config 모두 error로 차단한다.
//
// 별도 config 인 이유: no-restricted-syntax 는 같은 파일 세트에 같은 규칙이 다시 오면
// 병합이 아니라 교체(replace)된다. 메인 config 의 warn 항목(147-170행 인라인 DTO 경고)과
// 합치면 서로를 덮어쓰므로 dto:check 전용으로 분리 실행한다.
// 실행: pnpm --filter backend run dto:check  (규약 SoT: scripts/backend-guard/README.md)
import tseslint from 'typescript-eslint';

// 허용 DTO suffix — RequestDto | ResponseDto | QueryDto | ParamsDto | MessageDto | StatusDto
const OK_SUFFIX = '(Request|Response|Query|Params|Message|Status)Dto$';

const dtoDecorator = (name) =>
  `Identifier:has(Decorator[expression.callee.name=${name}])`;

export default [
  {
    files: ['src/**/*.dto.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `ExportNamedDeclaration > TSInterfaceDeclaration[id.name=/Dto$/]:not([id.name=/${OK_SUFFIX}/])`,
          message:
            'exported DTO 이름은 RequestDto | ResponseDto | QueryDto | ParamsDto | MessageDto | StatusDto 로 끝나야 합니다.',
        },
        {
          selector: `ExportNamedDeclaration > TSTypeAliasDeclaration[id.name=/Dto$/]:not([id.name=/${OK_SUFFIX}/])`,
          message:
            'exported DTO 이름은 RequestDto | ResponseDto | QueryDto | ParamsDto | MessageDto | StatusDto 로 끝나야 합니다.',
        },
        {
          selector: `ExportNamedDeclaration > ClassDeclaration[id.name=/Dto$/]:not([id.name=/${OK_SUFFIX}/])`,
          message:
            'exported DTO 이름은 RequestDto | ResponseDto | QueryDto | ParamsDto | MessageDto | StatusDto 로 끝나야 합니다.',
        },
      ],
    },
  },
  {
    files: ['src/**/*.controller.ts'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: `${dtoDecorator('/^(Body|Query|Param)$/')} > TSTypeAnnotation > TSTypeReference[typeName.name="Record"]`,
          message:
            '컨트롤러 경계는 Record<…> 를 쓰지 않습니다. RequestDto/QueryDto/ParamsDto 를 정의하세요.',
        },
        {
          selector: `${dtoDecorator('"Body"')} > TSTypeAnnotation > TSTypeLiteral`,
          message: '@Body() 는 인라인 객체 타입이 아닌 named *RequestDto 를 사용하세요.',
        },
        {
          selector: `${dtoDecorator('"Query"')} > TSTypeAnnotation > TSTypeLiteral`,
          message: '@Query() 는 인라인 객체 타입이 아닌 named *QueryDto 를 사용하세요.',
        },
        {
          selector: `${dtoDecorator('"Param"')} > TSTypeAnnotation > TSTypeLiteral`,
          message: '@Param() 은 인라인 객체 타입이 아닌 named *ParamsDto 를 사용하세요.',
        },
        {
          selector: `${dtoDecorator('"Body"')} > TSTypeAnnotation > TSTypeReference:not([typeName.name=/RequestDto$/])`,
          message: '@Body() 타입 이름은 RequestDto 로 끝나야 합니다.',
        },
        {
          // named 타입도 인라인 리터럴도 아닌 @Body (primitive/union/무타입) 차단.
          selector: `${dtoDecorator('"Body"')}[typeAnnotation.typeAnnotation.type!="TSTypeReference"][typeAnnotation.typeAnnotation.type!="TSTypeLiteral"]`,
          message: '@Body() 파라미터에는 named *RequestDto 타입 애노테이션이 필요합니다.',
        },
      ],
    },
  },
];
