import ts from 'typescript';
import path from 'node:path';

export const productionFiles = ['src/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'];
const normalized = (name) => name.replaceAll('\\', '/');
const caches = new WeakMap();
const roleDirectories = {
  controller: 'controllers',
  repository: 'repositories',
  service: 'services',
  adapter: 'adapters',
  guard: 'guards',
  interceptor: 'interceptors',
  filter: 'filters',
  pipe: 'pipes',
  module: 'modules',
};
const roleNames = Object.keys(roleDirectories);
const inputRoles = { Body: 'request', Query: 'query', Param: 'params' };
const dtoFile =
  /\/dto\/[^/]+-(?:request|response|query|params)\.dto\.[cm]?tsx?$/;

function facts(program) {
  if (caches.has(program)) return caches.get(program);
  const checker = program.getTypeChecker();
  const registrations = new Set();
  const abstractTokens = new Set();
  const automaticConstruction = new Set();
  const factoryConstruction = new Set();
  const manualServices = new Set();
  const explicitMetadata = new Set();
  const unsupportedModules = new Set();
  const requestOwners = new Set();
  const canonical = (symbol) => {
    const seen = new Set();
    while (symbol && symbol.flags & ts.SymbolFlags.Alias && !seen.has(symbol)) {
      seen.add(symbol);
      symbol = checker.getAliasedSymbol(symbol);
    }
    return symbol;
  };
  const symbolAt = (node) =>
    node ? canonical(checker.getSymbolAtLocation(node)) : undefined;
  function typeOnly(symbol, seen = new Set()) {
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    for (const declaration of symbol.declarations ?? []) {
      if (
        ts.isImportSpecifier(declaration) &&
        (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)
      )
        return true;
      if (ts.isImportClause(declaration) && declaration.isTypeOnly) return true;
      if (ts.isNamespaceImport(declaration) && declaration.parent.isTypeOnly)
        return true;
      if (
        ts.isExportSpecifier(declaration) &&
        (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)
      )
        return true;
    }
    return (
      Boolean(symbol.flags & ts.SymbolFlags.Alias) &&
      typeOnly(checker.getImmediateAliasedSymbol(symbol), seen)
    );
  }
  const nestName = (node) => {
    const symbol = symbolAt(node);
    return symbol?.declarations?.some((declaration) =>
      normalized(declaration.getSourceFile().fileName).includes(
        '/@nestjs/common/',
      ),
    )
      ? symbol.name
      : undefined;
  };
  const decorators = (node) =>
    ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
  const decoratorName = (decorator) =>
    nestName(
      ts.isCallExpression(decorator.expression)
        ? decorator.expression.expression
        : decorator.expression,
    );
  const hint = (node) => {
    const name = node.name?.getText() ?? '';
    const file = normalized(node.getSourceFile().fileName);
    return roleNames.filter(
      (role) =>
        name.endsWith(role[0].toUpperCase() + role.slice(1)) ||
        file.includes(`/${roleDirectories[role]}/`) ||
        new RegExp(`\\.${role}\\.[cm]?tsx?$`).test(file),
    );
  };
  function role(node, includeManual = true) {
    const names = decorators(node).map(decoratorName);
    if (names.includes('Controller')) return 'controller';
    if (names.includes('Module')) return 'module';
    if (includeManual && manualServices.has(symbolAt(node.name)))
      return 'service';
    const hints = hint(node);
    if (
      hints.length === 1 &&
      (names.includes('Injectable') || registrations.has(symbolAt(node.name)))
    )
      return hints[0];
    return undefined;
  }
  function register(expression, automatic = true) {
    const symbol = symbolAt(expression);
    if (symbol?.declarations?.some(ts.isClassDeclaration)) {
      registrations.add(symbol);
      if (automatic) automaticConstruction.add(symbol);
      return true;
    }
    return false;
  }
  function plainData(type, seen = new Set()) {
    if (
      type.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined)
    )
      return true;
    if (
      type.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Never |
        ts.TypeFlags.TypeParameter)
    )
      return false;
    if (type.isUnion())
      return type.types.every((member) => plainData(member, new Set(seen)));
    if (
      seen.has(type) ||
      seen.size >= 8 ||
      type.getCallSignatures().length ||
      type.getConstructSignatures().length
    )
      return false;
    seen.add(type);
    if (checker.isArrayType(type) || checker.isTupleType(type))
      return checker
        .getTypeArguments(type)
        .every((member) => plainData(member, new Set(seen)));
    if (type.getStringIndexType() || type.getNumberIndexType()) return false;
    return (
      Boolean(type.flags & ts.TypeFlags.Object) &&
      type.getProperties().every((property) => {
        const declaration =
          property.valueDeclaration ?? property.declarations?.[0];
        return (
          declaration &&
          plainData(
            checker.getTypeOfSymbolAtLocation(property, declaration),
            new Set(seen),
          )
        );
      })
    );
  }
  function constantValue(expression, seen = new Set()) {
    const type = checker.getTypeAtLocation(expression);
    if (!plainData(type)) return false;
    if (type.flags & ts.TypeFlags.Undefined) return true;
    if (
      ts.isStringLiteralLike(expression) ||
      ts.isNumericLiteral(expression) ||
      ts.isBigIntLiteral(expression) ||
      [
        ts.SyntaxKind.TrueKeyword,
        ts.SyntaxKind.FalseKeyword,
        ts.SyntaxKind.NullKeyword,
      ].includes(expression.kind)
    )
      return true;
    if (ts.isPrefixUnaryExpression(expression))
      return constantValue(expression.operand, seen);
    if (ts.isArrayLiteralExpression(expression))
      return expression.elements.every(
        (item) =>
          !ts.isSpreadElement(item) && constantValue(item, new Set(seen)),
      );
    if (ts.isObjectLiteralExpression(expression))
      return expression.properties.every(
        (item) =>
          ts.isPropertyAssignment(item) &&
          !ts.isComputedPropertyName(item.name) &&
          constantValue(item.initializer, new Set(seen)),
      );
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(expression);
      if (!symbol || seen.has(symbol)) return false;
      seen.add(symbol);
      const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
      return Boolean(
        declaration?.initializer &&
        ts.isVariableDeclarationList(declaration.parent) &&
        declaration.parent.flags & ts.NodeFlags.Const &&
        constantValue(declaration.initializer, seen),
      );
    }
    return false;
  }
  function factoryValue(expression) {
    let fn = expression;
    if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) {
      const declaration = symbolAt(expression)?.declarations?.find(
        (item) =>
          ts.isFunctionDeclaration(item) || ts.isVariableDeclaration(item),
      );
      fn =
        declaration && ts.isVariableDeclaration(declaration)
          ? declaration.initializer
          : declaration;
    }
    if (
      !fn ||
      !(
        ts.isArrowFunction(fn) ||
        ts.isFunctionExpression(fn) ||
        ts.isFunctionDeclaration(fn)
      ) ||
      !fn.body
    )
      return false;
    const signature = checker.getSignatureFromDeclaration(fn);
    if (!signature) return false;
    const returnType = checker.getAwaitedType(
      checker.getReturnTypeOfSignature(signature),
    );
    if (!returnType) return false;
    if (
      returnType.flags &
      (ts.TypeFlags.Any |
        ts.TypeFlags.Unknown |
        ts.TypeFlags.Never |
        ts.TypeFlags.TypeParameter)
    )
      return false;
    const returns = [];
    function gatherReturns(node) {
      if (node !== fn.body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) returns.push(node.expression);
      else ts.forEachChild(node, gatherReturns);
    }
    if (ts.isBlock(fn.body)) gatherReturns(fn.body);
    else returns.push(fn.body);
    if (!returns.length || returns.some((item) => !item)) return false;
    const classes = new Set();
    for (const result of returns) {
      if (ts.isNewExpression(result)) {
        const symbol = symbolAt(result.expression);
        if (
          !symbol?.declarations?.some(ts.isClassDeclaration) ||
          checker.getTypeAtLocation(result).getSymbol() !==
            returnType.getSymbol()
        )
          return false;
        classes.add(symbol);
      } else if (ts.isObjectLiteralExpression(result)) {
        if (
          !plainData(returnType) ||
          !plainData(checker.getTypeAtLocation(result)) ||
          result.properties.some(
            (item) =>
              !(
                ts.isPropertyAssignment(item) ||
                ts.isShorthandPropertyAssignment(item)
              ) || ts.isComputedPropertyName(item.name),
          )
        )
          return false;
      } else if (!constantValue(result) || !plainData(returnType)) return false;
    }
    for (const symbol of classes) {
      registrations.add(symbol);
      factoryConstruction.add(symbol);
    }
    return true;
  }
  function provider(item) {
    if (!ts.isObjectLiteralExpression(item)) return false;
    const entries = new Map();
    for (const entry of item.properties) {
      if (
        !ts.isPropertyAssignment(entry) ||
        !(ts.isIdentifier(entry.name) || ts.isStringLiteral(entry.name)) ||
        entries.has(entry.name.text)
      )
        return false;
      entries.set(entry.name.text, entry.initializer);
    }
    if (
      !entries.has('provide') ||
      [...entries.keys()].some(
        (key) =>
          ![
            'provide',
            'inject',
            'useClass',
            'useExisting',
            'useValue',
            'useFactory',
          ].includes(key),
      )
    )
      return false;
    const choices = [
      'useClass',
      'useExisting',
      'useValue',
      'useFactory',
    ].filter((key) => entries.has(key));
    if (choices.length !== 1) return false;
    const token = entries.get('provide');
    if (
      !(
        ts.isStringLiteralLike(token) ||
        (ts.isIdentifier(token) && symbolAt(token)) ||
        (ts.isPropertyAccessExpression(token) && symbolAt(token))
      )
    )
      return false;
    const inject = entries.get('inject');
    if (
      inject &&
      (!ts.isArrayLiteralExpression(inject) ||
        inject.elements.some(
          (entry) =>
            !(
              ts.isStringLiteralLike(entry) ||
              (ts.isIdentifier(entry) && symbolAt(entry)) ||
              (ts.isPropertyAccessExpression(entry) && symbolAt(entry))
            ),
        ))
    )
      return false;
    const kind = choices[0];
    const value = entries.get(kind);
    const valid =
      kind === 'useClass' || kind === 'useExisting'
        ? register(value, kind === 'useClass')
        : kind === 'useValue'
          ? !inject && constantValue(value)
          : factoryValue(value);
    if (!valid) return false;
    const tokenSymbol = symbolAt(token);
    const declaration = tokenSymbol?.declarations?.find(ts.isClassDeclaration);
    if (
      declaration?.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword,
      )
    ) {
      let root = token;
      while (ts.isPropertyAccessExpression(root)) root = root.expression;
      if (!ts.isIdentifier(root)) return false;
      const local = checker.getSymbolAtLocation(root);
      if (typeOnly(local) || typeOnly(checker.getSymbolAtLocation(token)))
        return false;
      const factoryResult =
        kind === 'useFactory'
          ? checker
              .getTypeAtLocation(value)
              .getCallSignatures()[0]
              ?.getReturnType()
          : undefined;
      const implementation =
        kind === 'useClass' || kind === 'useExisting'
          ? checker.getDeclaredTypeOfSymbol(symbolAt(value))
          : kind === 'useValue'
            ? checker.getTypeAtLocation(value)
            : factoryResult && checker.getAwaitedType(factoryResult);
      if (
        !implementation ||
        !checker.isTypeAssignableTo(
          implementation,
          checker.getDeclaredTypeOfSymbol(tokenSymbol),
        )
      )
        return false;
      abstractTokens.add(tokenSymbol);
    }
    return true;
  }
  for (const source of program.getSourceFiles()) {
    if (
      source.isDeclarationFile ||
      normalized(source.fileName).includes('/node_modules/')
    )
      continue;
    function visit(node) {
      if (ts.isCallExpression(node)) {
        const symbol = symbolAt(node.expression);
        const maintainedReflect = symbol?.declarations?.some((declaration) =>
          normalized(declaration.getSourceFile().fileName).includes(
            '/reflect-metadata/',
          ),
        );
        if (maintainedReflect && symbol.name === 'defineMetadata')
          explicitMetadata.add(symbolAt(node.arguments[2]));
        if (maintainedReflect && symbol.name === 'decorate')
          explicitMetadata.add(symbolAt(node.arguments[1]));
        if (ts.isCallExpression(node.expression)) {
          const factory = symbolAt(node.expression.expression);
          if (
            factory?.name === 'metadata' &&
            factory.declarations?.some((declaration) =>
              normalized(declaration.getSourceFile().fileName).includes(
                '/reflect-metadata/',
              ),
            )
          )
            explicitMetadata.add(symbolAt(node.arguments[0]));
        }
      }
      if (
        ts.isParameter(node) &&
        node.type &&
        ts.isTypeReferenceNode(node.type)
      ) {
        for (const decorator of decorators(node)) {
          const name = decoratorName(decorator);
          if (!Object.hasOwn(inputRoles, name)) continue;
          const expression = decorator.expression;
          if (
            !ts.isCallExpression(expression) ||
            expression.arguments.length > 0
          )
            continue;
          const declaration = symbolAt(node.type.typeName)?.declarations?.find(
            (item) =>
              ts.isClassDeclaration(item) ||
              ts.isInterfaceDeclaration(item) ||
              ts.isTypeAliasDeclaration(item),
          );
          if (declaration)
            requestOwners.add(declaration.getSourceFile().fileName);
        }
      }
      if (ts.isClassDeclaration(node)) {
        for (const decorator of decorators(node)) {
          if (decoratorName(decorator) !== 'Module') continue;
          const expression = decorator.expression;
          const metadata =
            ts.isCallExpression(expression) && expression.arguments[0];
          if (!metadata || !ts.isObjectLiteralExpression(metadata)) {
            unsupportedModules.add(decorator);
            continue;
          }
          for (const property of metadata.properties) {
            if (
              !ts.isPropertyAssignment(property) ||
              !ts.isIdentifier(property.name)
            ) {
              unsupportedModules.add(property);
              continue;
            }
            if (!['providers', 'controllers'].includes(property.name.text))
              continue;
            if (!ts.isArrayLiteralExpression(property.initializer)) {
              unsupportedModules.add(property);
              continue;
            }
            for (const item of property.initializer.elements) {
              if (register(item)) continue;
              if (property.name.text === 'providers' && provider(item))
                continue;
              unsupportedModules.add(item);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  const configFile = program.getCompilerOptions().configFilePath;
  const realPath = (file) =>
    ts.sys.realpath ? ts.sys.realpath(file) : path.resolve(file);
  const projectRoot =
    typeof configFile === 'string'
      ? realPath(path.resolve(path.dirname(configFile), 'src'))
      : undefined;
  function manualDomain(file) {
    if (!projectRoot) return undefined;
    const relative = path.relative(projectRoot, realPath(file));
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`)
    )
      return undefined;
    const parts = normalized(relative).split('/');
    return parts.length >= 2 && !parts.includes('node_modules')
      ? parts[0]
      : undefined;
  }
  for (const source of program.getSourceFiles()) {
    if (
      source.isDeclarationFile ||
      /(?:\.spec|\.test)\.[cm]?[jt]sx?$/.test(source.fileName) ||
      !manualDomain(source.fileName)
    )
      continue;
    function visitManual(node) {
      if (
        ts.isReturnStatement(node) &&
        node.expression &&
        ts.isNewExpression(node.expression) &&
        ts.isBlock(node.parent) &&
        ts.isMethodDeclaration(node.parent.parent)
      ) {
        const method = node.parent.parent;
        const producer = method.parent;
        const expression = node.expression;
        const targetSymbol = symbolAt(expression.expression);
        const target = targetSymbol?.declarations?.find(ts.isClassDeclaration);
        let root = expression.expression;
        while (ts.isPropertyAccessExpression(root)) root = root.expression;
        const signature = checker.getSignatureFromDeclaration(method);
        const returned =
          signature &&
          checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
        const constructed = checker.getResolvedSignature(expression);
        const targetRole = target && role(target, false);
        if (
          ts.isClassDeclaration(producer) &&
          role(producer, false) === 'service' &&
          !method.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
          ) &&
          target &&
          !target.getSourceFile().isDeclarationFile &&
          !target.modifiers?.some(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.AbstractKeyword ||
              modifier.kind === ts.SyntaxKind.DeclareKeyword,
          ) &&
          (!targetRole || targetRole === 'service') &&
          decorators(target).every(
            (decorator) => decoratorName(decorator) === 'Injectable',
          ) &&
          target.name?.text.endsWith('Service') &&
          /\/services\/[^/]+\.service\.[cm]?tsx?$/.test(
            normalized(target.getSourceFile().fileName),
          ) &&
          manualDomain(target.getSourceFile().fileName) ===
            manualDomain(source.fileName) &&
          ts.isIdentifier(root) &&
          !typeOnly(checker.getSymbolAtLocation(root)) &&
          !typeOnly(checker.getSymbolAtLocation(expression.expression)) &&
          canonical(returned?.getSymbol()) === targetSymbol &&
          canonical(constructed?.getReturnType().getSymbol()) ===
            targetSymbol &&
          !constructed?.declaration?.modifiers?.some(
            (modifier) =>
              modifier.kind === ts.SyntaxKind.PrivateKeyword ||
              modifier.kind === ts.SyntaxKind.ProtectedKeyword,
          ) &&
          (constructed?.declaration === target ||
            constructed?.declaration?.parent === target)
        ) {
          manualServices.add(targetSymbol);
        }
      }
      ts.forEachChild(node, visitManual);
    }
    visitManual(source);
  }
  const result = {
    checker,
    canonical,
    typeOnly,
    symbolAt,
    nestName,
    decorators,
    decoratorName,
    role,
    hint,
    registrations,
    abstractTokens,
    automaticConstruction,
    factoryConstruction,
    manualServices,
    explicitMetadata,
    unsupportedModules,
    requestOwners,
  };
  caches.set(program, result);
  return result;
}

const rule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      program:
        'Architecture checks require a TypeScript project and parser node maps; this file cannot be skipped.',
      role: 'Cannot classify production class {{name}} from Nest/module facts and a unique role; explicitly resolve its ownership.',
      placement:
        '{{role}} {{name}} must agree with its role class name, filename and domain directory.',
      module:
        'Unsupported computed/dynamic module provider metadata; explicitly resolve this binding.',
      dependency: '{{role}} cannot depend on resolved {{target}} ({{name}}).',
      unresolved:
        'Cannot resolve dependency {{name}}; computed or opaque dependency boundaries require explicit review.',
      dto: '@{{binding}} container must resolve to an exported domain-owned *Dto declaration in dto/<operation>-{{inputRole}}.dto.ts, not an anonymous/unsafe/unrelated alias.',
      dtoPlacement:
        'Owned DTO {{name}} needs a dto/<operation>-<request|response|query|params>.dto.ts filename; keep its existing *Dto declaration name.',
      metadata:
        'Request class {{name}} is imported type-only; preserve its runtime decorator metadata.',
      di: 'Constructor parameter needs emitted runtime-class metadata, an explicit Nest Inject token, or a proved metadata-free default/optional construction contract.',
      io: 'Resolved {{effect}} operation {{name}} requires canonical service/repository/adapter ownership (HTTP transport may belong to a controller, guard or filter).',
      effect:
        'Cannot prove helper operation {{name}} computational from its resolved declaration; classify this producer explicitly.',
      boundary:
        'Unsupported parameter decorator, selector, selected type or pipe contract; explicitly classify this request boundary.',
      test: 'Production code cannot depend on a test file to bypass architecture checks.',
    },
  },
  create(context) {
    return {
      Program(root) {
        const services = context.sourceCode.parserServices;
        if (!services?.program || !services.esTreeNodeToTSNodeMap) {
          context.report({ node: root, messageId: 'program' });
          return;
        }
        const source = services.esTreeNodeToTSNodeMap.get(root);
        const {
          checker,
          canonical,
          typeOnly,
          symbolAt,
          nestName,
          decorators,
          decoratorName,
          role,
          hint,
          registrations,
          abstractTokens,
          automaticConstruction,
          factoryConstruction,
          manualServices,
          explicitMetadata,
          unsupportedModules,
          requestOwners,
        } = facts(services.program);
        const filename = normalized(source.fileName);
        const configFile = services.program.getCompilerOptions().configFilePath;
        if (typeof configFile !== 'string') {
          context.report({ node: root, messageId: 'program' });
          return;
        }
        const realPath = (file) =>
          ts.sys.realpath ? ts.sys.realpath(file) : path.resolve(file);
        const projectSourceRoot = realPath(
          path.resolve(path.dirname(configFile), 'src'),
        );
        const infrastructurePath = realPath(
          path.join(projectSourceRoot, 'prisma', 'prisma.service.ts'),
        );
        const infrastructureSource = services.program
          .getSourceFiles()
          .find((item) => realPath(item.fileName) === infrastructurePath);
        const infrastructureClass = infrastructureSource?.statements.find(
          (item) =>
            ts.isClassDeclaration(item) && item.name?.text === 'PrismaService',
        );
        const infrastructureSymbol = infrastructureClass
          ? symbolAt(infrastructureClass.name)
          : undefined;
        function infrastructureOwner(declaration) {
          const owner = ts.isClassDeclaration(declaration)
            ? declaration
            : (ts.isMethodDeclaration(declaration) ||
                  ts.isPropertyDeclaration(declaration) ||
                  ts.isGetAccessorDeclaration(declaration) ||
                  ts.isSetAccessorDeclaration(declaration)) &&
                ts.isClassDeclaration(declaration.parent)
              ? declaration.parent
              : undefined;
          return Boolean(
            infrastructureSymbol &&
            owner &&
            symbolAt(owner.name) === infrastructureSymbol,
          );
        }
        function ownedDomain(file) {
          const relative = path.relative(projectSourceRoot, realPath(file));
          if (
            !relative ||
            path.isAbsolute(relative) ||
            relative === '..' ||
            relative.startsWith(`..${path.sep}`)
          )
            return undefined;
          const parts = normalized(relative).split('/');
          if (parts.includes('node_modules') || parts.length < 2)
            return undefined;
          return parts[0];
        }
        // A test-looking filename alone is not an architecture exemption.
        let jestSuite = false;
        function findSuite(node) {
          if (ts.isCallExpression(node)) {
            const symbol = symbolAt(node.expression);
            if (
              ['describe', 'it', 'test'].includes(symbol?.name) &&
              symbol.declarations?.some((declaration) =>
                /\/(?:@types\/jest|@jest\/globals)\//.test(
                  normalized(declaration.getSourceFile().fileName),
                ),
              )
            )
              jestSuite = true;
          }
          ts.forEachChild(node, findSuite);
        }
        if (/\.(?:spec|e2e-spec)\.ts$/.test(filename)) {
          findSuite(source);
          if (jestSuite) return;
        }
        const reported = new Set();
        function report(node, messageId, data = {}) {
          const key = `${node.pos}:${messageId}:${JSON.stringify(data)}`;
          if (reported.has(key)) return;
          reported.add(key);
          const start = source.getLineAndCharacterOfPosition(
            node.getStart(source),
          );
          const end = source.getLineAndCharacterOfPosition(node.getEnd());
          context.report({
            node: root,
            loc: {
              start: { line: start.line + 1, column: start.character },
              end: { line: end.line + 1, column: end.character },
            },
            messageId,
            data,
          });
        }
        const classes = [];
        function gather(node) {
          if (ts.isClassDeclaration(node)) classes.push(node);
          ts.forEachChild(node, gather);
        }
        gather(source);
        const roles = new Set(
          classes.map((node) => role(node)).filter(Boolean),
        );
        const canonicalFunctionalRole = [
          'service',
          'repository',
          'adapter',
        ].find(
          (entry) =>
            filename.includes(`/${roleDirectories[entry]}/`) &&
            new RegExp(`\\.${entry}\\.[cm]?tsx?$`).test(filename),
        );
        function runtimeExport(symbol) {
          if (!symbol) return false;
          const module = checker.getSymbolAtLocation(source);
          return Boolean(
            module &&
            checker
              .getExportsOfModule(module)
              .some((entry) => canonical(entry) === symbol && !typeOnly(entry)),
          );
        }
        function nativeDeclaration(symbol, name, suffix) {
          return (
            symbol?.name === name &&
            symbol.declarations?.some((declaration) =>
              normalized(declaration.getSourceFile().fileName).endsWith(suffix),
            )
          );
        }
        function runtimeReference(expression) {
          const root = ts.isPropertyAccessExpression(expression)
            ? expression.expression
            : expression;
          return (
            ts.isIdentifier(root) &&
            !typeOnly(checker.getSymbolAtLocation(root)) &&
            !typeOnly(checker.getSymbolAtLocation(expression)) &&
            (root === expression ||
              checker
                .getSymbolAtLocation(root)
                ?.declarations?.some(ts.isNamespaceImport))
          );
        }
        const contextOperations = new Set();
        for (const statement of source.statements) {
          if (
            !ts.isVariableStatement(statement) ||
            !(statement.declarationList.flags & ts.NodeFlags.Const)
          )
            continue;
          for (const declaration of statement.declarationList.declarations) {
            if (declaration.type || !runtimeExport(symbolAt(declaration.name)))
              continue;
            let literal = declaration.initializer;
            while (
              literal &&
              (ts.isParenthesizedExpression(literal) ||
                (ts.isAsExpression(literal) &&
                  literal.type.getText() === 'const'))
            )
              literal = literal.expression;
            if (
              !literal ||
              !ts.isObjectLiteralExpression(literal) ||
              !literal.properties.length
            )
              continue;
            const bodies = [];
            for (const member of literal.properties) {
              if (!member.name || ts.isComputedPropertyName(member.name)) break;
              const fn = ts.isMethodDeclaration(member)
                ? member
                : ts.isPropertyAssignment(member) &&
                    (ts.isArrowFunction(member.initializer) ||
                      ts.isFunctionExpression(member.initializer))
                  ? member.initializer
                  : undefined;
              if (
                !fn?.body ||
                decorators(fn).length ||
                !checker.getTypeAtLocation(fn).getCallSignatures().length
              )
                break;
              bodies.push(fn.body);
            }
            if (bodies.length !== literal.properties.length) continue;
            const operations = new Set();
            function inspectContext(node) {
              if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression)
              ) {
                const method = checker.getResolvedSignature(node)?.declaration;
                const storage = symbolAt(
                  node.expression.expression,
                )?.declarations?.find(ts.isVariableDeclaration);
                const creation = storage?.initializer;
                if (
                  method &&
                  ['run', 'getStore'].includes(method.name?.getText()) &&
                  method.parent?.name?.getText() === 'AsyncLocalStorage' &&
                  normalized(method.getSourceFile().fileName).endsWith(
                    '/@types/node/async_hooks.d.ts',
                  ) &&
                  storage &&
                  storage.getSourceFile() === source &&
                  ts.isVariableDeclarationList(storage.parent) &&
                  storage.parent.parent.parent === source &&
                  storage.parent.flags & ts.NodeFlags.Const &&
                  creation &&
                  ts.isNewExpression(creation) &&
                  runtimeReference(creation.expression) &&
                  nativeDeclaration(
                    symbolAt(creation.expression),
                    'AsyncLocalStorage',
                    '/@types/node/async_hooks.d.ts',
                  )
                ) {
                  operations.add(node);
                  operations.add(creation);
                }
              }
              ts.forEachChild(node, inspectContext);
            }
            for (const body of bodies) inspectContext(body);
            for (const operation of operations)
              contextOperations.add(operation);
          }
        }
        const ordinaryImplementation = source.statements.some(
          (node) =>
            node.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            ) &&
            (ts.isFunctionDeclaration(node) ||
              ts.isClassDeclaration(node) ||
              (ts.isVariableStatement(node) &&
                node.declarationList.declarations.some(
                  (declaration) =>
                    declaration.initializer &&
                    checker
                      .getTypeAtLocation(declaration.initializer)
                      .getCallSignatures().length > 0,
                ))),
        );
        const contextImplementation =
          canonicalFunctionalRole === 'service' && contextOperations.size > 0;
        const exportedImplementation =
          ordinaryImplementation || contextImplementation;
        const contextOnly = contextImplementation && !ordinaryImplementation;
        if (canonicalFunctionalRole && exportedImplementation)
          roles.add(canonicalFunctionalRole);
        const dtoModule =
          filename.includes('/dto/') ||
          /\.dto\.[cm]?[jt]sx?$/.test(filename) ||
          requestOwners.has(source.fileName);
        if (dtoModule) roles.add('dto');
        function isHttp(symbol, seen = new Set()) {
          if (!symbol || seen.has(symbol)) return false;
          seen.add(symbol);
          for (const declaration of symbol.declarations ?? []) {
            if (
              symbol.name === 'HttpException' &&
              normalized(declaration.getSourceFile().fileName).includes(
                '/@nestjs/common/',
              )
            )
              return true;
            if (ts.isClassDeclaration(declaration)) {
              for (const clause of declaration.heritageClauses ?? []) {
                if (
                  clause.token === ts.SyntaxKind.ExtendsKeyword &&
                  clause.types.some((base) =>
                    isHttp(symbolAt(base.expression), seen),
                  )
                )
                  return true;
              }
            }
          }
          return false;
        }
        function nativeError(symbol, seen = new Set()) {
          if (!symbol || seen.has(symbol) || isHttp(symbol)) return false;
          seen.add(symbol);
          for (const declaration of symbol.declarations ?? []) {
            if (
              symbol.name === 'Error' &&
              declaration.getSourceFile().hasNoDefaultLib
            )
              return true;
            if (ts.isClassDeclaration(declaration)) {
              for (const clause of declaration.heritageClauses ?? []) {
                if (
                  clause.token === ts.SyntaxKind.ExtendsKeyword &&
                  clause.types.some((base) =>
                    nativeError(symbolAt(base.expression), seen),
                  )
                )
                  return true;
              }
            }
          }
          return false;
        }
        function publicBaseTypes(type) {
          if (!(type.flags & ts.TypeFlags.Object)) return [];
          const target =
            type.objectFlags & ts.ObjectFlags.Reference ? type.target : type;
          return target?.objectFlags & ts.ObjectFlags.ClassOrInterface
            ? checker.getBaseTypes(target)
            : [];
        }
        function expressType(type, name, seen = new Set()) {
          if (
            seen.has(type) ||
            seen.size > 12 ||
            type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
          )
            return false;
          seen.add(type);
          if (type.isIntersection())
            return type.types.some((part) => expressType(part, name, seen));
          const symbol = type.getSymbol();
          if (
            symbol?.name === name &&
            symbol.declarations?.some((declaration) =>
              /\/@types\/express(?:-serve-static-core)?\/index\.d\.ts$/.test(
                normalized(declaration.getSourceFile().fileName),
              ),
            )
          )
            return true;
          return publicBaseTypes(type).some((base) =>
            expressType(base, name, seen),
          );
        }
        function uncertainHttpParts(type, depth = 0) {
          if (
            depth > 12 ||
            type.flags &
              (ts.TypeFlags.Any |
                ts.TypeFlags.Unknown |
                ts.TypeFlags.TypeParameter |
                ts.TypeFlags.Never)
          )
            return true;
          return (
            (type.isUnion() || type.isIntersection()) &&
            type.types.some((part) => uncertainHttpParts(part, depth + 1))
          );
        }
        function nodeHttpDeclaration(type, name) {
          const symbol = type.getSymbol();
          return Boolean(
            symbol?.name === name &&
            symbol.declarations?.some((declaration) =>
              /\/@types\/node\/http\.d\.ts$/.test(
                normalized(declaration.getSourceFile().fileName),
              ),
            ),
          );
        }
        // Inbound permission proof: an uncertain constituent must not grant
        // transport authority, so unresolved parts fail closed.
        function nodeHttpType(type, name, seen = new Set()) {
          if (seen.has(type) || seen.size > 12 || uncertainHttpParts(type))
            return false;
          seen.add(type);
          if (type.isUnion()) {
            const matches = type.types.map((part) =>
              nodeHttpType(part, name, new Set(seen)),
            );
            return name === 'ServerResponse'
              ? matches.every(Boolean)
              : matches.some(Boolean);
          }
          if (type.isIntersection())
            return type.types.some((part) =>
              nodeHttpType(part, name, new Set(seen)),
            );
          if (nodeHttpDeclaration(type, name)) return true;
          return publicBaseTypes(type).some((base) =>
            nodeHttpType(base, name, new Set(seen)),
          );
        }
        // Effect detection, not a permission proof: an uncertain sibling part of
        // an intersection/union cannot erase a resolved node:http constituent.
        function knownNodeHttpPart(type, name, seen = new Set()) {
          if (
            seen.has(type) ||
            seen.size > 12 ||
            type.flags &
              (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
          )
            return false;
          seen.add(type);
          // A constrained type parameter is not an unresolved part: the compiler
          // already knows its bound, and the inherited members a call resolves
          // through come from that bound.
          if (type.flags & ts.TypeFlags.TypeParameter) {
            const constraint = checker.getBaseConstraintOfType(type);
            return Boolean(
              constraint && knownNodeHttpPart(constraint, name, new Set(seen)),
            );
          }
          if (type.isUnion() || type.isIntersection())
            return type.types.some((part) =>
              knownNodeHttpPart(part, name, new Set(seen)),
            );
          if (nodeHttpDeclaration(type, name)) return true;
          return publicBaseTypes(type).some((base) =>
            knownNodeHttpPart(base, name, new Set(seen)),
          );
        }
        function transportParameter(node, kind) {
          return (
            ts.isParameter(node) &&
            decorators(node).some((decorator) =>
              (kind === 'Request'
                ? ['Req', 'Request']
                : ['Res', 'Response']
              ).includes(decoratorName(decorator)),
            ) &&
            expressType(checker.getTypeAtLocation(node), kind)
          );
        }
        function transportReceiver(expression, seen = new Set()) {
          if (!expression || seen.size > 8) return false;
          if (ts.isIdentifier(expression)) {
            const symbol = symbolAt(expression);
            if (!symbol || seen.has(symbol)) return false;
            seen.add(symbol);
            return (
              symbol.declarations?.some((declaration) => {
                if (ts.isParameter(declaration))
                  return (
                    transportParameter(declaration, 'Request') ||
                    transportParameter(declaration, 'Response')
                  );
                return (
                  ts.isVariableDeclaration(declaration) &&
                  declaration.initializer &&
                  ts.isVariableDeclarationList(declaration.parent) &&
                  Boolean(declaration.parent.flags & ts.NodeFlags.Const) &&
                  transportReceiver(declaration.initializer, seen)
                );
              }) ?? false
            );
          }
          if (ts.isPropertyAccessExpression(expression)) {
            const symbol = symbolAt(expression.name);
            return (
              symbol?.declarations?.some(
                (declaration) =>
                  /\/@types\/node\/http\.d\.ts$/.test(
                    normalized(declaration.getSourceFile().fileName),
                  ) && declaration.name?.getText() === 'socket',
              ) && transportReceiver(expression.expression, seen)
            );
          }
          if (
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression)
          ) {
            const declaration =
              checker.getResolvedSignature(expression)?.declaration;
            return Boolean(
              declaration &&
              /\/@types\/express-serve-static-core\/index\.d\.ts$/.test(
                normalized(declaration.getSourceFile().fileName),
              ) &&
              transportReceiver(expression.expression.expression, seen),
            );
          }
          return false;
        }
        function transportMethod(node) {
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (ts.isMethodDeclaration(parent))
              return ts.isClassDeclaration(parent.parent) &&
                role(parent.parent) === 'controller'
                ? parent
                : undefined;
          }
          return undefined;
        }
        function sseLifetime(node) {
          const method = transportMethod(node);
          return Boolean(
            method &&
            method.parameters.some((parameter) =>
              transportParameter(parameter, 'Request'),
            ) &&
            method.parameters.some((parameter) =>
              transportParameter(parameter, 'Response'),
            ) &&
            decorators(method).some((decorator) => {
              const expression = decorator.expression;
              return (
                decoratorName(decorator) === 'Header' &&
                ts.isCallExpression(expression) &&
                expression.arguments.length === 2 &&
                ts.isStringLiteral(expression.arguments[0]) &&
                expression.arguments[0].text.toLowerCase() === 'content-type' &&
                ts.isStringLiteral(expression.arguments[1]) &&
                expression.arguments[1].text === 'text/event-stream'
              );
            }),
          );
        }
        function nestFactoryReceiver(node, seen = new Set()) {
          const symbol = symbolAt(node);
          if (!symbol || seen.has(symbol) || seen.size > 8) return false;
          seen.add(symbol);
          return (
            symbol.declarations?.some((declaration) => {
              if (
                symbol.name === 'NestFactory' &&
                /\/@nestjs\/core\/nest-factory\.d\.ts$/.test(
                  normalized(declaration.getSourceFile().fileName),
                )
              )
                return true;
              return (
                ts.isVariableDeclaration(declaration) &&
                declaration.initializer &&
                ts.isVariableDeclarationList(declaration.parent) &&
                Boolean(declaration.parent.flags & ts.NodeFlags.Const) &&
                nestFactoryReceiver(declaration.initializer, seen)
              );
            }) ?? false
          );
        }
        function nestComposition(node) {
          if (
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression) ||
            !nestFactoryReceiver(node.expression.expression)
          )
            return false;
          const declaration = checker.getResolvedSignature(node)?.declaration;
          if (
            !declaration ||
            declaration.name?.getText() !== 'create' ||
            !/\/@nestjs\/core\/nest-factory\.d\.ts$/.test(
              normalized(declaration.getSourceFile().fileName),
            ) ||
            !ts.isClassDeclaration(declaration.parent) ||
            declaration.parent.name?.text !== 'NestFactoryStatic'
          )
            return false;
          return (
            symbolAt(node.arguments[0])?.declarations?.some(
              (item) =>
                ts.isClassDeclaration(item) &&
                decorators(item).some(
                  (decorator) => decoratorName(decorator) === 'Module',
                ),
            ) ?? false
          );
        }
        function directApplication(expression, aliases = 0) {
          if (!expression || !ts.isIdentifier(expression)) return false;
          const declaration = symbolAt(expression)?.declarations?.find(
            ts.isVariableDeclaration,
          );
          if (
            !declaration?.initializer ||
            !ts.isVariableDeclarationList(declaration.parent) ||
            !(declaration.parent.flags & ts.NodeFlags.Const)
          )
            return false;
          if (
            ts.isAwaitExpression(declaration.initializer) &&
            nestComposition(declaration.initializer.expression)
          )
            return declaration.initializer.expression;
          return aliases === 0
            ? directApplication(declaration.initializer, 1)
            : false;
        }
        function defaultExpressApplication(expression) {
          const creation = directApplication(expression);
          if (!creation || creation.arguments.length > 2) return false;
          const options = creation.arguments[1];
          // The public options overload uses Nest's default Express adapter;
          // opaque option/adapter values do not establish adapter provenance.
          if (!options) return true;
          const parameter =
            checker.getResolvedSignature(creation)?.declaration?.parameters[1];
          const type = parameter && checker.getTypeAtLocation(parameter);
          const optionTypes = type?.isUnion() ? type.types : type ? [type] : [];
          const optionsOverload = optionTypes.some((member) =>
            member
              .getSymbol()
              ?.declarations?.some(
                (declaration) =>
                  declaration.name?.text === 'NestApplicationOptions' &&
                  /\/@nestjs\/common\/interfaces\/nest-application-options\.interface\.d\.ts$/.test(
                    normalized(declaration.getSourceFile().fileName),
                  ),
              ),
          );
          return (
            optionsOverload &&
            ts.isObjectLiteralExpression(options) &&
            options.properties.every(
              (property) =>
                ts.isPropertyAssignment(property) &&
                !ts.isComputedPropertyName(property.name),
            )
          );
        }
        function applicationParameter(node) {
          const symbol = checker.getTypeAtLocation(node).getSymbol();
          return (
            symbol?.name === 'INestApplication' &&
            symbol.declarations?.some((declaration) =>
              /\/@nestjs\/common\/interfaces\/nest-application\.interface\.d\.ts$/.test(
                normalized(declaration.getSourceFile().fileName),
              ),
            )
          );
        }
        const forwardedParameters = new Map();
        const forwardingCalls = new Set();
        for (const programSource of services.program.getSourceFiles()) {
          if (
            programSource.isDeclarationFile ||
            /(?:\/node_modules\/|\/test\/|[.](?:spec|test)[.])/.test(
              normalized(programSource.fileName),
            )
          )
            continue;
          function collectForwarding(node) {
            if (ts.isCallExpression(node)) {
              const target = checker.getResolvedSignature(node)?.declaration;
              const targetPath =
                target &&
                path.relative(
                  projectSourceRoot,
                  realPath(target.getSourceFile().fileName),
                );
              if (
                target &&
                ts.isFunctionDeclaration(target) &&
                target.name &&
                symbolAt(node.expression) === symbolAt(target.name) &&
                target.body &&
                !target.getSourceFile().isDeclarationFile &&
                targetPath &&
                !path.isAbsolute(targetPath) &&
                targetPath !== '..' &&
                !targetPath.startsWith(`..${path.sep}`) &&
                !normalized(targetPath).split('/').includes('node_modules')
              ) {
                const parameters =
                  target.parameters.filter(applicationParameter);
                for (const parameter of parameters) {
                  const argument =
                    node.arguments[target.parameters.indexOf(parameter)];
                  const state = forwardedParameters.get(parameter) ?? {
                    good: 0,
                    bad: 0,
                  };
                  if (defaultExpressApplication(argument)) {
                    state.good += 1;
                    forwardingCalls.add(node);
                  } else state.bad += 1;
                  forwardedParameters.set(parameter, state);
                }
              }
            }
            ts.forEachChild(node, collectForwarding);
          }
          collectForwarding(programSource);
        }
        function forwardedApplication(expression, aliases = 0) {
          if (!expression || !ts.isIdentifier(expression)) return false;
          const declarations = symbolAt(expression)?.declarations ?? [];
          for (const declaration of declarations) {
            const state = forwardedParameters.get(declaration);
            if (state?.good && !state.bad) return true;
            if (
              aliases === 0 &&
              ts.isVariableDeclaration(declaration) &&
              declaration.initializer &&
              ts.isVariableDeclarationList(declaration.parent) &&
              declaration.parent.flags & ts.NodeFlags.Const &&
              forwardedApplication(declaration.initializer, 1)
            )
              return true;
          }
          return false;
        }
        function composedApplication(expression) {
          return Boolean(
            directApplication(expression) || forwardedApplication(expression),
          );
        }
        function frameworkCall(node, member) {
          if (
            !node ||
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression)
          )
            return false;
          const declaration = checker.getResolvedSignature(node)?.declaration;
          return (
            declaration?.name?.getText() === member &&
            /\/@nestjs\/common\/interfaces\/nest-application\.interface\.d\.ts$/.test(
              normalized(declaration.getSourceFile().fileName),
            ) &&
            (defaultExpressApplication(node.expression.expression) ||
              forwardedApplication(node.expression.expression))
          );
        }
        function publicContract(name, pattern) {
          for (const file of services.program.getSourceFiles()) {
            if (!pattern.test(normalized(file.fileName))) continue;
            const declaration = file.statements.find(
              (statement) => statement.name?.text === name,
            );
            if (declaration) return checker.getTypeAtLocation(declaration);
          }
          return undefined;
        }
        function expressJson(node) {
          if (!ts.isCallExpression(node)) return false;
          return (
            symbolAt(node.expression)?.declarations?.some(
              (declaration) =>
                declaration.name?.getText() === 'json' &&
                /\/@types\/express\/index\.d\.ts$/.test(
                  normalized(declaration.getSourceFile().fileName),
                ),
            ) ?? false
          );
        }
        function callbackContext(fn) {
          if (
            !fn ||
            !(
              ts.isArrowFunction(fn) ||
              ts.isFunctionExpression(fn) ||
              ts.isMethodDeclaration(fn)
            )
          )
            return undefined;
          if (frameworkCall(fn.parent, 'use') && fn.parameters.length === 4) {
            const contract = publicContract(
              'ErrorRequestHandler',
              /\/@types\/express-serve-static-core\/index\.d\.ts$/,
            );
            if (
              contract
                ?.getCallSignatures()
                .some((signature) => signature.parameters.length === 4) &&
              expressType(
                checker.getTypeAtLocation(fn.parameters[1]),
                'Request',
              ) &&
              expressType(
                checker.getTypeAtLocation(fn.parameters[2]),
                'Response',
              ) &&
              expressType(
                checker.getTypeAtLocation(fn.parameters[3]),
                'NextFunction',
              )
            )
              return 'middleware';
          }
          const property = ts.isMethodDeclaration(fn)
            ? fn
            : ts.isPropertyAssignment(fn.parent)
              ? fn.parent
              : undefined;
          if (
            !property ||
            !ts.isObjectLiteralExpression(property.parent) ||
            ts.isComputedPropertyName(property.name)
          )
            return undefined;
          const registration = property.parent.parent;
          if (
            property.name.getText() === 'origin' &&
            frameworkCall(registration, 'enableCors')
          ) {
            const contract = publicContract(
              'CustomOrigin',
              /\/@nestjs\/common\/interfaces\/external\/cors-options\.interface\.d\.ts$/,
            );
            if (
              contract &&
              checker.isTypeAssignableTo(
                checker.getTypeAtLocation(fn),
                contract,
              )
            )
              return 'cors';
          }
          if (
            property.name.getText() === 'verify' &&
            ts.isCallExpression(registration) &&
            expressJson(registration) &&
            frameworkCall(registration.parent, 'use')
          ) {
            const declaration =
              checker.getResolvedSignature(registration)?.declaration;
            if (
              declaration?.name?.getText() === 'json' &&
              /\/@types\/body-parser\/index\.d\.ts$/.test(
                normalized(declaration.getSourceFile().fileName),
              )
            )
              return 'verify';
          }
          return undefined;
        }
        function callbackParameter(expression, kind) {
          if (!expression || !ts.isIdentifier(expression)) return false;
          return (
            symbolAt(expression)?.declarations?.some((parameter) => {
              if (!ts.isParameter(parameter)) return false;
              const fn = parameter.parent;
              const context = callbackContext(fn);
              const index = fn.parameters.indexOf(parameter);
              return kind === 'continuation'
                ? (context === 'cors' && index === 1) ||
                    (context === 'middleware' && index === 3)
                : context === 'middleware' && index === 2;
            }) ?? false
          );
        }
        function middlewareResponse(expression) {
          if (callbackParameter(expression, 'response')) return true;
          if (
            expression &&
            ts.isCallExpression(expression) &&
            ts.isPropertyAccessExpression(expression.expression)
          ) {
            const declaration =
              checker.getResolvedSignature(expression)?.declaration;
            return (
              declaration &&
              /\/@types\/express-serve-static-core\/index\.d\.ts$/.test(
                normalized(declaration.getSourceFile().fileName),
              ) &&
              callbackParameter(expression.expression.expression, 'response')
            );
          }
          return false;
        }
        function expressInstance(expression, aliases = 0) {
          if (!expression || aliases > 3) return false;
          if (ts.isAsExpression(expression))
            return expressInstance(expression.expression, aliases + 1);
          if (ts.isIdentifier(expression)) {
            const declaration = symbolAt(expression)?.declarations?.find(
              ts.isVariableDeclaration,
            );
            return (
              declaration?.initializer &&
              ts.isVariableDeclarationList(declaration.parent) &&
              declaration.parent.flags & ts.NodeFlags.Const &&
              expressInstance(declaration.initializer, aliases + 1)
            );
          }
          if (
            !ts.isCallExpression(expression) ||
            !ts.isPropertyAccessExpression(expression.expression)
          )
            return false;
          const declaration =
            checker.getResolvedSignature(expression)?.declaration;
          return (
            declaration?.name?.getText() === 'getInstance' &&
            /\/@nestjs\/common\/interfaces\/http\/http-server\.interface\.d\.ts$/.test(
              normalized(declaration.getSourceFile().fileName),
            ) &&
            frameworkCall(expression.expression.expression, 'getHttpAdapter')
          );
        }
        const startupFunctions = new Map();
        function startupInvocation(node) {
          if (
            !ts.isCallExpression(node) ||
            !ts.isIdentifier(node.expression) ||
            node.arguments.length
          )
            return false;
          const declaration = checker.getResolvedSignature(node)?.declaration;
          if (
            !declaration ||
            !ts.isFunctionDeclaration(declaration) ||
            declaration.getSourceFile() !== source ||
            !declaration.body ||
            !declaration.name ||
            declaration.parameters.length ||
            symbolAt(node.expression) !== symbolAt(declaration.name) ||
            !declaration.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            )
          )
            return false;
          if (startupFunctions.has(declaration))
            return startupFunctions.get(declaration);
          let creation;
          let configured = false;
          let listening = false;
          for (const statement of declaration.body.statements) {
            if (ts.isVariableStatement(statement)) {
              for (const variable of statement.declarationList.declarations) {
                if (
                  ts.isIdentifier(variable.name) &&
                  variable.initializer &&
                  ts.isAwaitExpression(variable.initializer) &&
                  nestComposition(variable.initializer.expression) &&
                  directApplication(variable.name)
                ) {
                  if (creation) return false;
                  creation = directApplication(variable.name);
                }
              }
            } else if (ts.isExpressionStatement(statement)) {
              const awaited = ts.isAwaitExpression(statement.expression);
              const expression = awaited
                ? statement.expression.expression
                : statement.expression;
              if (
                creation &&
                ts.isCallExpression(expression) &&
                ts.isPropertyAccessExpression(expression.expression) &&
                directApplication(expression.expression.expression) === creation
              ) {
                const member = expression.expression.name.text;
                if (frameworkCall(expression, member)) {
                  if (member === 'listen' && awaited && configured)
                    listening = true;
                  else if (
                    [
                      'setGlobalPrefix',
                      'enableVersioning',
                      'useGlobalPipes',
                      'enableCors',
                      'use',
                    ].includes(member)
                  )
                    configured = true;
                }
              }
            } else {
              startupFunctions.set(declaration, false);
              return false;
            }
          }
          const result = Boolean(creation && configured && listening);
          startupFunctions.set(declaration, result);
          return result;
        }
        function startupCatch(node) {
          if (
            !ts.isCallExpression(node) ||
            node.arguments.length !== 1 ||
            !ts.isPropertyAccessExpression(node.expression) ||
            node.expression.name.text !== 'catch' ||
            !startupInvocation(node.expression.expression)
          )
            return false;
          const declaration = checker.getResolvedSignature(node)?.declaration;
          return Boolean(
            declaration?.getSourceFile().hasNoDefaultLib &&
            ts.isInterfaceDeclaration(declaration.parent) &&
            declaration.parent.name.text === 'Promise' &&
            (ts.isArrowFunction(node.arguments[0]) ||
              ts.isFunctionExpression(node.arguments[0])),
          );
        }
        function hostReceiver(expression, name, aliases = 0) {
          if (!ts.isIdentifier(expression)) return false;
          const declarations = symbolAt(expression)?.declarations ?? [];
          if (
            declarations.some(
              (declaration) =>
                ts.isVariableDeclaration(declaration) &&
                declaration.name.getText() === name &&
                normalized(declaration.getSourceFile().fileName).endsWith(
                  `/@types/node/${name}.d.ts`,
                ),
            )
          )
            return true;
          const variable = declarations.find(ts.isVariableDeclaration);
          return Boolean(
            aliases === 0 &&
            variable?.initializer &&
            ts.isVariableDeclarationList(variable.parent) &&
            variable.parent.flags & ts.NodeFlags.Const &&
            hostReceiver(variable.initializer, name, 1),
          );
        }
        function startupFailureOperation(node, call) {
          if (
            !ts.isCallExpression(node) ||
            !ts.isPropertyAccessExpression(node.expression) ||
            !call.declaration
          )
            return false;
          let callback = node.parent;
          while (callback && !ts.isFunctionLike(callback))
            callback = callback.parent;
          if (
            !callback ||
            !(
              ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)
            ) ||
            !startupCatch(callback.parent) ||
            callback.parent.arguments[0] !== callback
          )
            return false;
          const receiver = node.expression.expression;
          const file = normalized(call.declaration.getSourceFile().fileName);
          if (
            node.expression.name.text === 'error' &&
            symbolAt(node.expression)?.declarations?.some(
              (declaration) =>
                declaration.name?.getText() === 'error' &&
                normalized(declaration.getSourceFile().fileName).endsWith(
                  '/@types/node/console.d.ts',
                ),
            ) &&
            hostReceiver(receiver, 'console')
          )
            return true;
          return (
            call.declaration.name?.getText() === 'exit' &&
            file.endsWith('/@types/node/process.d.ts') &&
            hostReceiver(receiver, 'process') &&
            node.arguments.length === 1 &&
            ts.isNumericLiteral(node.arguments[0]) &&
            Number(node.arguments[0].text) > 0 &&
            Number(node.arguments[0].text) <= 255 &&
            Number.isInteger(Number(node.arguments[0].text))
          );
        }
        function bootstrapOperation(node, call) {
          if (
            startupInvocation(node) ||
            startupCatch(node) ||
            startupFailureOperation(node, call)
          )
            return true;
          if (nestComposition(node)) return true;
          if (forwardingCalls.has(node)) {
            const target = checker.getResolvedSignature(node)?.declaration;
            if (
              target?.parameters
                .filter(applicationParameter)
                .every((parameter) => {
                  const state = forwardedParameters.get(parameter);
                  return state?.good && !state.bad;
                })
            )
              return true;
          }
          if (
            ts.isCallExpression(node) &&
            callbackParameter(node.expression, 'continuation')
          )
            return true;
          if (ts.isCallExpression(node) && call.declaration) {
            const file = normalized(call.declaration.getSourceFile().fileName);
            if (
              ts.isPropertyAccessExpression(node.expression) &&
              middlewareResponse(node.expression.expression) &&
              /\/@types\/(?:express-serve-static-core\/index|node\/http)\.d\.ts$/.test(
                file,
              )
            )
              return true;
            if (
              call.declaration.name?.getText() === 'json' &&
              /\/@types\/body-parser\/index\.d\.ts$/.test(file) &&
              expressJson(node) &&
              frameworkCall(node.parent, 'use')
            )
              return true;
            if (expressInstance(node)) return true;
            if (
              ts.isPropertyAccessExpression(node.expression) &&
              expressInstance(node.expression.expression) &&
              /\/@types\/express-serve-static-core\/index\.d\.ts$/.test(file) &&
              call.declaration.name?.getText() === 'set' &&
              node.arguments.length === 2 &&
              ts.isStringLiteral(node.arguments[0]) &&
              node.arguments[0].text === 'trust proxy'
            )
              return true;
          }
          if (
            ts.isNewExpression(node) &&
            call.declaration &&
            /\/@nestjs\/common\/pipes\/validation\.pipe\.d\.ts$/.test(
              normalized(call.declaration.getSourceFile().fileName),
            ) &&
            ts.isCallExpression(node.parent) &&
            ts.isPropertyAccessExpression(node.parent.expression) &&
            composedApplication(node.parent.expression.expression)
          ) {
            const parentDeclaration = checker.getResolvedSignature(
              node.parent,
            )?.declaration;
            return (
              parentDeclaration?.name?.getText() === 'useGlobalPipes' &&
              /\/@nestjs\/common\/interfaces\/nest-application\.interface\.d\.ts$/.test(
                normalized(parentDeclaration.getSourceFile().fileName),
              )
            );
          }
          if (!ts.isCallExpression(node) || !call.declaration) return false;
          const file = normalized(call.declaration.getSourceFile().fileName);
          if (
            /\/@nestjs\/common\/interfaces\/nest-application(?:-context)?\.interface\.d\.ts$/.test(
              file,
            ) &&
            ts.isPropertyAccessExpression(node.expression) &&
            composedApplication(node.expression.expression)
          )
            return true;
          return (
            /\/@nestjs\/swagger\/dist\/swagger-module\.d\.ts$/.test(file) &&
            call.declaration.name?.getText() === 'setup' &&
            ts.isClassDeclaration(call.declaration.parent) &&
            call.declaration.parent.name?.text === 'SwaggerModule' &&
            composedApplication(node.arguments[1])
          );
        }
        // A const only implements a callable when its initializer is the
        // function body itself. Re-exporting an imported callable is an alias,
        // not an implementation, so the call keeps the effect of what it really
        // reaches.
        function implementsCallable(expression) {
          let node = expression;
          while (
            node &&
            (ts.isParenthesizedExpression(node) ||
              ts.isAsExpression(node) ||
              ts.isSatisfiesExpression(node))
          )
            node = node.expression;
          return (
            node &&
            (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
            Boolean(node.body)
          );
        }
        // The runtime declarations a callable symbol actually owns. Bodyless
        // overloads and function-type signatures are excluded: they describe a
        // call, they do not implement it.
        function callableImplementations(symbol) {
          const entry = canonical(symbol);
          if (!entry || typeOnly(entry)) return [];
          return (entry.declarations ?? []).filter(
            (declaration) =>
              (ts.isFunctionDeclaration(declaration) &&
                Boolean(declaration.body)) ||
              (ts.isVariableDeclaration(declaration) &&
                ts.isVariableDeclarationList(declaration.parent) &&
                Boolean(declaration.parent.flags & ts.NodeFlags.Const) &&
                implementsCallable(declaration.initializer)),
          );
        }
        function implementationName(declaration) {
          if (
            ts.isFunctionDeclaration(declaration) ||
            ts.isVariableDeclaration(declaration)
          )
            return declaration.name;
          return (ts.isArrowFunction(declaration) ||
            ts.isFunctionExpression(declaration)) &&
            ts.isVariableDeclaration(declaration.parent)
            ? declaration.parent.name
            : undefined;
        }
        // Repository ownership is a module fact, not a class-shape fact: a
        // canonical repository module's exported implementation carries the
        // same persistence effect as a repository class method.
        function canonicalRepositoryImplementation(implementation) {
          const target = implementation.getSourceFile();
          const name = implementationName(implementation);
          if (
            !name ||
            !ts.isIdentifier(name) ||
            target.isDeclarationFile ||
            !normalized(target.fileName).includes(
              `/${roleDirectories.repository}/`,
            ) ||
            !/\.repository\.[cm]?tsx?$/.test(normalized(target.fileName)) ||
            !ownedDomain(target.fileName)
          )
            return false;
          const module = checker.getSymbolAtLocation(target);
          const symbol = symbolAt(name);
          return Boolean(
            module &&
            symbol &&
            checker
              .getExportsOfModule(module)
              .some((entry) => canonical(entry) === symbol && !typeOnly(entry)),
          );
        }
        // Ownership follows the canonical callee symbol, not the resolved call
        // signature: an overload resolves to a bodyless declaration and an
        // annotated callable resolves to its function type, neither of which is
        // the exported repository implementation.
        function canonicalRepositoryFunction(declaration, symbol) {
          const own = declaration && implementationName(declaration);
          return [
            ...callableImplementations(symbol),
            ...(own && ts.isIdentifier(own)
              ? callableImplementations(symbolAt(own))
              : []),
          ].some(canonicalRepositoryImplementation);
        }
        function operation(node) {
          if (
            !(
              ts.isCallExpression(node) ||
              ts.isNewExpression(node) ||
              ts.isTaggedTemplateExpression(node)
            )
          )
            return undefined;
          const signature = checker.getResolvedSignature(node);
          const declaration = signature?.declaration;
          const expression = ts.isTaggedTemplateExpression(node)
            ? node.tag
            : node.expression;
          const symbol = symbolAt(expression);
          const file = declaration
            ? normalized(declaration.getSourceFile().fileName)
            : '';
          const name =
            declaration?.name?.getText() ??
            symbol?.name ??
            expression.getText();
          const eventType =
            declaration?.parameters?.[0]?.type &&
            checker.getTypeAtLocation(declaration.parameters[0].type);
          const closeSubscription =
            eventType?.flags & ts.TypeFlags.StringLiteral &&
            eventType.value === 'close' &&
            declaration.parameters[1] &&
            checker
              .getTypeAtLocation(declaration.parameters[1])
              .getCallSignatures().length > 0;
          if (
            ['write', 'end'].includes(name) &&
            /\/@types\/node\/stream\.d\.ts$/.test(file) &&
            declaration?.parent?.name?.getText() === 'Writable' &&
            ts.isPropertyAccessExpression(expression) &&
            knownNodeHttpPart(
              checker.getTypeAtLocation(expression.expression),
              'ClientRequest',
            )
          )
            return { effect: 'network', name, declaration };
          if (
            ['setHeader', 'removeHeader'].includes(name) &&
            /\/@types\/node\/http\.d\.ts$/.test(file) &&
            declaration?.parent?.name?.getText() === 'OutgoingMessage' &&
            ts.isPropertyAccessExpression(expression)
          ) {
            const receiver = checker.getTypeAtLocation(expression.expression);
            if (
              nodeHttpType(receiver, 'ServerResponse') &&
              !nodeHttpType(receiver, 'ClientRequest')
            )
              return { effect: 'HTTP transport', name, declaration };
          }
          if (
            !['setHeader', 'removeHeader'].includes(name) &&
            ts.isPropertyAccessExpression(expression) &&
            transportMethod(node) &&
            transportReceiver(expression.expression) &&
            (/\/@types\/node\/(?:http|stream)\.d\.ts$/.test(file) ||
              (closeSubscription &&
                /\/@types\/node\/(?:net|events)\.d\.ts$/.test(file)))
          )
            return { effect: 'HTTP transport', name, declaration };
          if (declaration && infrastructureOwner(declaration))
            return { effect: 'persistence', name, declaration };
          if (
            declaration?.parent &&
            ts.isClassDeclaration(declaration.parent) &&
            role(declaration.parent) === 'repository'
          )
            return { effect: 'persistence', name, declaration };
          if (canonicalRepositoryFunction(declaration, symbol))
            return { effect: 'persistence', name, declaration };
          if (
            file.includes('/.prisma/client/') ||
            file.includes('/@prisma/client/')
          )
            return { effect: 'persistence', name, declaration };
          if (
            /\/@types\/node\/(?:fs(?:\/promises)?|child_process|worker_threads)\.d\.ts$/.test(
              file,
            )
          )
            return {
              effect: file.includes('/fs') ? 'filesystem' : 'subprocess',
              name,
              declaration,
            };
          if (
            /\/@types\/node\/(?:https?|http2|net|tls|dgram|dns(?:\/promises)?)\.d\.ts$/.test(
              file,
            ) ||
            file.includes('/undici-types/') ||
            file.includes('/@types/nodemailer/')
          )
            return { effect: 'network', name, declaration };
          if (
            (file.includes('/@types/node/') ||
              declaration?.getSourceFile().hasNoDefaultLib) &&
            [
              'setTimeout',
              'setInterval',
              'setImmediate',
              'clearTimeout',
              'clearInterval',
              'clearImmediate',
            ].includes(name)
          )
            return { effect: 'timer', name, declaration };
          if (file.includes('/@types/node/timers'))
            return { effect: 'timer', name, declaration };
          if (
            name === 'fetch' &&
            (declaration?.getSourceFile().hasNoDefaultLib ||
              file.includes('/@types/node/'))
          )
            return { effect: 'network', name, declaration };
          if (
            file.includes('/@types/express-serve-static-core/') ||
            file.includes('/@types/express/') ||
            (file.includes('/@nestjs/common/') &&
              /\/interfaces\/.*application/.test(file))
          )
            return { effect: 'HTTP transport', name, declaration };
          return { name, declaration, symbol };
        }
        function nodeImportName(expression, moduleName) {
          if (!ts.isIdentifier(expression)) return undefined;
          const symbol = checker.getSymbolAtLocation(expression);
          if (typeOnly(symbol)) return undefined;
          for (const declaration of symbol?.declarations ?? []) {
            if (
              !ts.isImportSpecifier(declaration) &&
              !ts.isNamespaceImport(declaration) &&
              !ts.isImportClause(declaration)
            )
              continue;
            let imported = declaration.parent;
            while (imported && !ts.isImportDeclaration(imported))
              imported = imported.parent;
            if (
              !imported ||
              !checker
                .getSymbolAtLocation(imported.moduleSpecifier)
                ?.declarations?.some((item) =>
                  normalized(item.getSourceFile().fileName).endsWith(
                    `/@types/node/${moduleName}.d.ts`,
                  ),
                )
            )
              continue;
            return ts.isImportSpecifier(declaration)
              ? (declaration.propertyName ?? declaration.name).text
              : '*';
          }
          return undefined;
        }
        function pathValue(expression, depth = 0) {
          const imported = nodeImportName(expression, 'path');
          if (['*', 'default', 'posix', 'win32'].includes(imported))
            return true;
          return (
            depth === 0 &&
            ts.isPropertyAccessExpression(expression) &&
            ['posix', 'win32'].includes(expression.name.text) &&
            symbolAt(expression)?.declarations?.some((declaration) =>
              normalized(declaration.getSourceFile().fileName).endsWith(
                '/@types/node/path.d.ts',
              ),
            ) &&
            pathValue(expression.expression, 1)
          );
        }
        function nativePathRead(node, call) {
          if (!ts.isCallExpression(node) || !call.declaration) return false;
          const name = call.declaration.name?.getText();
          const file = normalized(call.declaration.getSourceFile().fileName);
          if (
            file.endsWith('/@types/node/path.d.ts') &&
            ['join', 'dirname', 'resolve'].includes(name) &&
            call.declaration.parent?.name?.getText() === 'PlatformPath'
          ) {
            return (
              nodeImportName(node.expression, 'path') === name ||
              (ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === name &&
                pathValue(node.expression.expression))
            );
          }
          if (
            file.endsWith('/@types/node/process.d.ts') &&
            name === 'cwd' &&
            call.declaration.parent?.name?.getText() === 'Process'
          ) {
            return (
              nodeImportName(node.expression, 'process') === 'cwd' ||
              (ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === 'cwd' &&
                !typeOnly(
                  checker.getSymbolAtLocation(node.expression.expression),
                ) &&
                (['*', 'default'].includes(
                  nodeImportName(node.expression.expression, 'process'),
                ) ||
                  hostReceiver(node.expression.expression, 'process', 1)))
            );
          }
          return false;
        }
        function metadataFactory(node) {
          if (
            !ts.isCallExpression(node) ||
            node.arguments.length !== 2 ||
            node.arguments.some(ts.isSpreadElement) ||
            !/\/decorators\/[^/]+\.decorator\.[cm]?tsx?$/.test(filename) ||
            !runtimeReference(node.expression) ||
            !nativeDeclaration(
              symbolAt(node.expression),
              'SetMetadata',
              '/@nestjs/common/decorators/core/set-metadata.decorator.d.ts',
            )
          )
            return false;
          const fn = node.parent;
          if (
            !ts.isArrowFunction(fn) ||
            fn.body !== node ||
            fn.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            ) ||
            !ts.isVariableDeclaration(fn.parent) ||
            !(fn.parent.parent.flags & ts.NodeFlags.Const) ||
            !runtimeExport(symbolAt(fn.parent.name))
          )
            return false;
          const value = checker.getTypeAtLocation(node);
          const signature = checker.getSignatureFromDeclaration(fn);
          const result =
            signature && checker.getReturnTypeOfSignature(signature);
          return (
            nativeDeclaration(
              canonical(value.aliasSymbol),
              'CustomDecorator',
              '/@nestjs/common/decorators/core/set-metadata.decorator.d.ts',
            ) &&
            result &&
            !(
              result.flags &
              (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)
            ) &&
            result.getCallSignatures().length >= 2 &&
            checker.isTypeAssignableTo(value, result)
          );
        }
        function scopeContinuation(node, call) {
          if (
            !ts.isCallExpression(node) ||
            call.effect !== 'persistence' ||
            call.declaration?.name?.getText() !== 'withFacilityContext' ||
            !infrastructureOwner(call.declaration) ||
            !ts.isPropertyAccessExpression(node.expression) ||
            node.arguments.length !== 2
          )
            return false;
          const fn = node.parent;
          if (
            !ts.isArrowFunction(fn) ||
            fn.body !== node ||
            fn.parameters.length !== 1 ||
            fn.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
            ) ||
            fn.typeParameters?.length !== 1 ||
            node.typeArguments?.length !== 1 ||
            !ts.isTypeReferenceNode(node.typeArguments[0]) ||
            symbolAt(node.typeArguments[0].typeName) !==
              symbolAt(fn.typeParameters[0].name) ||
            fn.parameters[0].initializer ||
            fn.parameters[0].dotDotDotToken ||
            !ts.isIdentifier(node.arguments[1]) ||
            symbolAt(node.arguments[1]) !== symbolAt(fn.parameters[0].name) ||
            !checker.getTypeAtLocation(fn.parameters[0]).getCallSignatures()
              .length
          )
            return false;
          const assignment = fn.parent;
          if (
            !ts.isBinaryExpression(assignment) ||
            assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            assignment.right !== fn ||
            !ts.isPropertyAccessExpression(assignment.left) ||
            assignment.left.name.text !== 'withFacilityContext' ||
            !ts.isExpressionStatement(assignment.parent) ||
            !ts.isBlock(assignment.parent.parent)
          )
            return false;
          const method = assignment.parent.parent.parent;
          if (
            !ts.isMethodDeclaration(method) ||
            method.name.getText() !== 'intercept' ||
            method.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
            ) ||
            method.parameters.length !== 2 ||
            !ts.isClassDeclaration(method.parent)
          )
            return false;
          const owner = method.parent;
          const ownerSymbol = symbolAt(owner.name);
          // Resolve the contract from the implements clause, which carries
          // @nestjs/common's own default type arguments. The interface
          // declaration resolves to NestInterceptor<T, R> over its unbound
          // parameters, which no concrete interceptor return type satisfies.
          const interceptorContract = (owner.heritageClauses ?? [])
            .filter(
              (clause) => clause.token === ts.SyntaxKind.ImplementsKeyword,
            )
            .flatMap((clause) => [...clause.types])
            .map((type) => checker.getTypeAtLocation(type))
            .find((type) =>
              nativeDeclaration(
                canonical(type.getSymbol()),
                'NestInterceptor',
                '/@nestjs/common/interfaces/features/nest-interceptor.interface.d.ts',
              ),
            );
          if (
            !ownerSymbol ||
            role(owner) !== 'interceptor' ||
            !decorators(owner).some(
              (item) => decoratorName(item) === 'Injectable',
            ) ||
            !interceptorContract ||
            !checker.isTypeAssignableTo(
              checker.getDeclaredTypeOfSymbol(ownerSymbol),
              interceptorContract,
            )
          )
            return false;
          if (
            !nativeDeclaration(
              canonical(
                checker.getTypeAtLocation(method.parameters[0]).getSymbol(),
              ),
              'ExecutionContext',
              '/@nestjs/common/interfaces/features/execution-context.interface.d.ts',
            ) ||
            !nativeDeclaration(
              canonical(
                checker.getTypeAtLocation(method.parameters[1]).getSymbol(),
              ),
              'CallHandler',
              '/@nestjs/common/interfaces/features/nest-interceptor.interface.d.ts',
            )
          )
            return false;
          const receiver = node.expression.expression;
          const parameter = symbolAt(receiver)?.declarations?.find(
            ts.isParameter,
          );
          if (
            !ts.isPropertyAccessExpression(receiver) ||
            receiver.expression.kind !== ts.SyntaxKind.ThisKeyword ||
            !parameter ||
            !ts.isConstructorDeclaration(parameter.parent) ||
            parameter.parent.parent !== owner ||
            !ts.isParameterPropertyDeclaration(parameter, parameter.parent) ||
            decorators(parameter).length ||
            !parameter.type ||
            !ts.isTypeReferenceNode(parameter.type) ||
            !runtimeReference(parameter.type.typeName) ||
            symbolAt(parameter.type.typeName) !== infrastructureSymbol
          )
            return false;
          const request = symbolAt(
            assignment.left.expression,
          )?.declarations?.find(ts.isVariableDeclaration);
          const get = request?.initializer;
          const switchCall =
            get &&
            ts.isCallExpression(get) &&
            ts.isPropertyAccessExpression(get.expression)
              ? get.expression.expression
              : undefined;
          const getDeclaration =
            get && ts.isCallExpression(get)
              ? checker.getResolvedSignature(get)?.declaration
              : undefined;
          if (
            !request ||
            request.parent.parent.parent !== method.body ||
            !(request.parent.flags & ts.NodeFlags.Const) ||
            !switchCall ||
            !ts.isCallExpression(switchCall) ||
            !ts.isPropertyAccessExpression(switchCall.expression) ||
            symbolAt(switchCall.expression.expression) !==
              symbolAt(method.parameters[0].name) ||
            getDeclaration?.name?.getText() !== 'getRequest' ||
            !normalized(getDeclaration.getSourceFile().fileName).endsWith(
              '/@nestjs/common/interfaces/features/arguments-host.interface.d.ts',
            )
          )
            return false;
          const switched =
            checker.getResolvedSignature(switchCall)?.declaration;
          if (
            switched?.name?.getText() !== 'switchToHttp' ||
            !normalized(switched.getSourceFile().fileName).endsWith(
              '/@nestjs/common/interfaces/features/arguments-host.interface.d.ts',
            )
          )
            return false;
          const facility = symbolAt(node.arguments[0])?.declarations?.find(
            ts.isVariableDeclaration,
          );
          if (
            !ts.isIdentifier(node.arguments[0]) ||
            !facility ||
            !(facility.parent.flags & ts.NodeFlags.Const) ||
            facility.parent.parent.parent !== method.body
          )
            return false;
          const last = method.body?.statements.at(-1);
          const handle =
            last && ts.isReturnStatement(last) ? last.expression : undefined;
          const handled =
            handle && ts.isCallExpression(handle)
              ? checker.getResolvedSignature(handle)?.declaration
              : undefined;
          return (
            handle &&
            ts.isCallExpression(handle) &&
            ts.isPropertyAccessExpression(handle.expression) &&
            symbolAt(handle.expression.expression) ===
              symbolAt(method.parameters[1].name) &&
            handled?.name?.getText() === 'handle' &&
            normalized(handled.getSourceFile().fileName).endsWith(
              '/@nestjs/common/interfaces/features/nest-interceptor.interface.d.ts',
            )
          );
        }
        function computational(node, visiting = new Set()) {
          if (!node || visiting.has(node)) return true;
          visiting.add(node);
          let pure = true;
          function scan(child) {
            if (!pure || ts.isTypeNode(child) || ts.isDecorator(child)) return;
            const call = operation(child);
            if (call) {
              const declaration = call.declaration;
              const file = declaration
                ? normalized(declaration.getSourceFile().fileName)
                : '';
              if (call.effect) {
                pure = false;
                return;
              }
              const declarationOwner = declaration?.parent;
              const configRead =
                declaration &&
                ts.isMethodDeclaration(declaration) &&
                ['get', 'getOrThrow'].includes(declaration.name.getText()) &&
                declarationOwner &&
                ts.isClassDeclaration(declarationOwner) &&
                declarationOwner.name?.text === 'ConfigService' &&
                /\/@nestjs\/config\/dist\/config\.service\.d\.ts$/.test(file);
              const encodingValue =
                declarationOwner &&
                (ts.isClassDeclaration(declarationOwner) ||
                  ts.isInterfaceDeclaration(declarationOwner)) &&
                ['TextDecoder', 'TextEncoder'].includes(
                  declarationOwner.name?.text,
                ) &&
                /\/@types\/node\/util\.d\.ts$/.test(file);
              if (
                configRead ||
                encodingValue ||
                nativePathRead(child, call) ||
                metadataFactory(child) ||
                declaration?.getSourceFile().hasNoDefaultLib ||
                /\/@types\/node\/(?:buffer(?:\.buffer)?|crypto)\.d\.ts$/.test(
                  file,
                )
              ) {
                // Compiler library value operations and native Buffer/crypto
                // operations are not database, transport or filesystem calls.
              } else if (
                declaration?.getSourceFile() === source &&
                declaration.body
              ) {
                if (!computational(declaration.body, visiting)) {
                  pure = false;
                  return;
                }
              } else if (call.symbol && nativeError(call.symbol)) {
                // Domain Error construction carries no transport semantics.
              } else {
                pure = false;
                return;
              }
            }
            ts.forEachChild(child, scan);
          }
          scan(node);
          return pure;
        }
        const auxiliaryRoles = new Map();
        for (const node of classes) {
          const symbol = symbolAt(node.name);
          const moduleSymbol = checker.getSymbolAtLocation(
            node.getSourceFile(),
          );
          const runtimeExport =
            moduleSymbol &&
            checker
              .getExportsOfModule(moduleSymbol)
              .some(
                (exported) =>
                  canonical(exported) === symbol && !typeOnly(exported),
              );
          if (
            abstractTokens.has(symbol) &&
            !registrations.has(symbol) &&
            !explicitMetadata.has(symbol) &&
            !decorators(node).length &&
            !node.heritageClauses?.length &&
            runtimeExport &&
            node.members.length > 0 &&
            node.members.every(
              (member) =>
                (ts.isMethodDeclaration(member) ||
                  ts.isPropertyDeclaration(member)) &&
                member.modifiers?.some(
                  (modifier) => modifier.kind === ts.SyntaxKind.AbstractKeyword,
                ) &&
                !member.modifiers?.some(
                  (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
                ) &&
                !member.body &&
                !member.initializer &&
                !decorators(member).length &&
                !ts.isComputedPropertyName(member.name) &&
                !member.parameters?.some(
                  (parameter) =>
                    parameter.initializer || decorators(parameter).length,
                ),
            )
          ) {
            auxiliaryRoles.set(node, 'port');
            continue;
          }
          if (
            role(node) ||
            registrations.has(symbol) ||
            decorators(node).length ||
            dtoModule
          )
            continue;
          if (nativeError(symbol)) auxiliaryRoles.set(node, 'error');
          else if (!node.heritageClauses?.length && computational(node))
            auxiliaryRoles.set(node, 'helper');
        }
        function typePosition(node) {
          for (
            let current = node;
            current && current !== source;
            current = current.parent
          ) {
            if (ts.isTypeNode(current)) return true;
            if (ts.isImportSpecifier(current))
              return current.isTypeOnly || current.parent.parent.isTypeOnly;
            if (ts.isImportClause(current)) return current.isTypeOnly;
            if (ts.isExportSpecifier(current))
              return current.isTypeOnly || current.parent.parent.isTypeOnly;
            if (ts.isExportDeclaration(current)) return current.isTypeOnly;
            if (ts.isExpressionStatement(current) || ts.isStatement(current))
              break;
          }
          return false;
        }
        function prismaData(symbol, node) {
          const type = checker.getTypeOfSymbolAtLocation(symbol, node);
          const dataFlags =
            ts.TypeFlags.StringLiteral |
            ts.TypeFlags.NumberLiteral |
            ts.TypeFlags.BooleanLiteral |
            ts.TypeFlags.EnumLiteral |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined;
          if (type.flags & dataFlags) return true;
          if (symbol.flags & (ts.SymbolFlags.Enum | ts.SymbolFlags.EnumMember))
            return true;
          if (
            type.getCallSignatures().length ||
            type.getConstructSignatures().length
          )
            return false;
          const properties = type.getProperties();
          return (
            properties.length > 0 &&
            properties.every((property) => {
              const member = checker.getTypeOfSymbolAtLocation(property, node);
              return Boolean(member.flags & dataFlags);
            })
          );
        }
        function generatedDataType(type, seen = new Set()) {
          const scalar =
            ts.TypeFlags.StringLike |
            ts.TypeFlags.NumberLike |
            ts.TypeFlags.BigIntLike |
            ts.TypeFlags.BooleanLike |
            ts.TypeFlags.EnumLike |
            ts.TypeFlags.Null |
            ts.TypeFlags.Undefined;
          if (type.flags & scalar) return true;
          if (
            type.flags &
            (ts.TypeFlags.Any |
              ts.TypeFlags.Unknown |
              ts.TypeFlags.Never |
              ts.TypeFlags.TypeParameter)
          )
            return false;
          if (type.isUnion())
            return type.types.every((member) =>
              generatedDataType(member, new Set(seen)),
            );
          if (seen.has(type) || seen.size >= 8) return false;
          seen.add(type);
          if (
            type.getCallSignatures().length ||
            type.getConstructSignatures().length
          )
            return false;
          const symbol = type.getSymbol();
          if (
            symbol?.name === 'Date' &&
            symbol.declarations?.some(
              (declaration) => declaration.getSourceFile().hasNoDefaultLib,
            )
          )
            return true;
          const properties = type.getProperties();
          return (
            properties.length > 0 &&
            properties.every((property) =>
              generatedDataType(
                checker.getTypeOfSymbolAtLocation(property, source),
                new Set(seen),
              ),
            )
          );
        }
        function generatedDataReference(symbol, node) {
          // Use the instantiated use-site type for mapped generated model fields.
          // Methods/getters/client constructors remain persistence dependencies.
          const property = symbol.declarations.some(ts.isPropertySignature);
          const dataType = symbol.declarations.some(
            (item) =>
              ts.isTypeAliasDeclaration(item) ||
              ts.isInterfaceDeclaration(item),
          );
          return (
            (property || (dataType && typePosition(node))) &&
            generatedDataType(checker.getTypeAtLocation(node))
          );
        }
        function inspectSymbol(raw, node, seen = new Set()) {
          const symbol = canonical(raw);
          if (!symbol || !symbol.declarations?.length) return;
          if (seen.has(symbol)) return;
          seen.add(symbol);
          const constructors = checker
            .getTypeOfSymbolAtLocation(symbol, node)
            .getConstructSignatures();
          for (const signature of constructors) {
            const instance = signature.getReturnType().getSymbol();
            if (instance && instance !== symbol)
              inspectSymbol(instance, node, seen);
          }
          for (const declaration of symbol.declarations) {
            const targetFile = normalized(declaration.getSourceFile().fileName);
            if (
              /\.(?:spec|e2e-spec)\.ts$/.test(targetFile) ||
              targetFile.includes('/test/')
            )
              report(node, 'test');
            let target;
            if (
              !targetFile.includes('/node_modules/') &&
              targetFile.includes('/src/')
            ) {
              target = roleNames.find(
                (entry) =>
                  targetFile.includes(`/${roleDirectories[entry]}/`) ||
                  new RegExp(`\\.${entry}\\.[cm]?tsx?$`).test(targetFile),
              );
            }
            const generatedPrisma =
              targetFile.includes('/@prisma/client/') ||
              targetFile.includes('/.prisma/client/');
            if (generatedPrisma) target = 'prisma';
            if (ts.isClassDeclaration(declaration)) {
              target = role(declaration) ?? target;
            }
            if (infrastructureOwner(declaration)) target = 'prisma';
            if (isHttp(symbol)) target = 'http';
            for (const owner of roles) {
              const denied =
                owner === 'controller'
                  ? ['repository', 'adapter', 'prisma']
                  : owner === 'repository'
                    ? ['http', 'controller', 'service', 'adapter']
                    : owner === 'service'
                      ? ['controller', 'adapter']
                      : owner === 'dto'
                        ? [
                            'controller',
                            'service',
                            'repository',
                            'adapter',
                            'prisma',
                          ]
                        : [];
              if (
                (owner === 'dto' || owner === 'controller') &&
                target === 'prisma' &&
                generatedPrisma
              ) {
                // An imported namespace is a container, not executed database
                // behavior. Inspect its actual referenced members separately.
                const container =
                  declaration.kind === ts.SyntaxKind.SourceFile ||
                  ts.isModuleDeclaration(declaration);
                if (
                  container ||
                  (owner === 'dto' && typePosition(node)) ||
                  prismaData(symbol, node) ||
                  generatedDataReference(symbol, node)
                )
                  continue;
              }
              if (denied.includes(target))
                report(node, 'dependency', {
                  role: owner,
                  target,
                  name: symbol.name,
                });
            }
          }
        }
        for (const node of classes) {
          const currentRole = role(node);
          const file = normalized(node.getSourceFile().fileName);
          const dto =
            dtoModule &&
            node.name?.text.endsWith('Dto') &&
            node.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            ) &&
            !registrations.has(symbolAt(node.name)) &&
            !decorators(node).some(
              (decorator) => decoratorName(decorator) === 'Injectable',
            );
          const auxiliaryRole = auxiliaryRoles.get(node);
          if (
            !currentRole &&
            !dto &&
            !auxiliaryRole &&
            !isHttp(symbolAt(node.name))
          )
            report(node, 'role', { name: node.name?.text ?? '<anonymous>' });
          if (
            auxiliaryRole &&
            !(
              filename.includes(`/${auxiliaryRole}s/`) &&
              new RegExp(`\\.${auxiliaryRole}\\.[cm]?tsx?$`).test(filename)
            )
          )
            report(node, 'placement', {
              role: auxiliaryRole,
              name: node.name?.text ?? '<anonymous>',
            });
          const prismaInfrastructure =
            node.name?.text === 'PrismaService' &&
            file.endsWith('/src/prisma/prisma.service.ts');
          if (currentRole === 'module') {
            const relative = normalized(
              path.relative(projectSourceRoot, realPath(file)),
            );
            const parts = relative.split('/');
            const className = node.name?.text ?? '';
            const namedModule = /^[A-Z][A-Za-z0-9]*Module$/.test(className);
            const compositionRoot =
              relative === 'app.module.ts' && className === 'AppModule';
            const reservedDirectories = new Set([
              ...Object.values(roleDirectories),
              'helpers',
              'dto',
              'node_modules',
            ]);
            const domainRoot =
              parts.length === 2 &&
              parts[0] !== '..' &&
              !path.isAbsolute(relative) &&
              !reservedDirectories.has(parts[0]) &&
              /^[^/]+\.module\.[cm]?tsx?$/.test(parts[1]);
            if (
              !namedModule ||
              !(compositionRoot || domainRoot) ||
              hint(node).some((entry) => entry !== currentRole)
            )
              report(node, 'placement', {
                role: currentRole,
                name: className || '<anonymous>',
              });
          } else if (currentRole && !prismaInfrastructure) {
            const correct =
              file.includes(`/${roleDirectories[currentRole]}/`) &&
              new RegExp(`\\.${currentRole}\\.[cm]?tsx?$`).test(file);
            const coreRole = ['controller', 'service', 'repository'].includes(
              currentRole,
            );
            const classSuffix =
              currentRole[0].toUpperCase() + currentRole.slice(1);
            const correctName =
              !coreRole ||
              new RegExp(`^[A-Z][A-Za-z0-9]*${classSuffix}$`).test(
                node.name?.text ?? '',
              );
            if (
              !correct ||
              !correctName ||
              hint(node).some((entry) => entry !== currentRole)
            )
              report(node, 'placement', {
                role: currentRole,
                name: node.name?.text ?? '<anonymous>',
              });
          }
          // Injectable alone is deliberately insufficient for role inference.
          if (!currentRole && registrations.has(symbolAt(node.name)))
            report(node, 'role', { name: node.name?.text ?? '<anonymous>' });
        }
        function selectedShape(type, collection = false) {
          if (
            type.flags &
            (ts.TypeFlags.Any |
              ts.TypeFlags.Unknown |
              ts.TypeFlags.Never |
              ts.TypeFlags.TypeParameter |
              ts.TypeFlags.Void)
          )
            return 'unknown';
          if (type.isUnion()) {
            const members = type.types.filter(
              (member) =>
                !(member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)),
            );
            if (!members.length) return 'unknown';
            const shapes = members.map((member) =>
              selectedShape(member, collection),
            );
            return shapes.includes('unknown')
              ? 'unknown'
              : shapes.every((shape) => shape === 'scalar')
                ? 'scalar'
                : 'container';
          }
          if (type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined))
            return collection ? 'scalar' : 'unknown';
          if (
            type.flags &
            (ts.TypeFlags.StringLike |
              ts.TypeFlags.NumberLike |
              ts.TypeFlags.BooleanLike |
              ts.TypeFlags.BigIntLike)
          )
            return 'scalar';
          if (checker.isArrayType(type) || checker.isTupleType(type)) {
            if (collection) return 'container';
            const elements = checker.getTypeArguments(type);
            if (!elements.length)
              return checker.isTupleType(type) ? 'scalar' : 'unknown';
            const shapes = elements.map((element) =>
              selectedShape(element, true),
            );
            return shapes.includes('unknown')
              ? 'unknown'
              : shapes.every((shape) => shape === 'scalar')
                ? 'scalar'
                : 'container';
          }
          return 'container';
        }
        function pipeClass(expression) {
          const target = ts.isNewExpression(expression)
            ? expression.expression
            : expression;
          const local = checker.getSymbolAtLocation(target);
          if (typeOnly(local)) return undefined;
          const declarations = canonical(local)?.declarations ?? [];
          const direct = declarations.find(ts.isClassDeclaration);
          if (direct) return direct;
          const variable = declarations.find(ts.isVariableDeclaration);
          if (
            variable?.initializer &&
            ts.isNewExpression(variable.initializer) &&
            ts.isVariableDeclarationList(variable.parent) &&
            variable.parent.flags & ts.NodeFlags.Const
          )
            return symbolAt(
              variable.initializer.expression,
            )?.declarations?.find(ts.isClassDeclaration);
          return undefined;
        }
        function realPipe(declaration, seen = new Set()) {
          if (!declaration || seen.has(declaration)) return false;
          seen.add(declaration);
          for (const clause of declaration.heritageClauses ?? []) {
            for (const base of clause.types) {
              const symbol = symbolAt(base.expression);
              if (
                symbol?.name === 'PipeTransform' &&
                symbol.declarations?.some((item) =>
                  /\/@nestjs\/common\/interfaces\/features\/pipe-transform\.interface\.d\.ts$/.test(
                    normalized(item.getSourceFile().fileName),
                  ),
                )
              )
                return true;
              if (
                symbol?.declarations?.some(
                  (item) => ts.isClassDeclaration(item) && realPipe(item, seen),
                )
              )
                return true;
            }
          }
          return false;
        }
        function selectedPipes(expressions, parameterType) {
          let previous;
          for (const expression of expressions) {
            const declaration = pipeClass(expression);
            if (!realPipe(declaration)) return false;
            const instance = checker.getTypeAtLocation(declaration);
            const transform = instance.getProperty('transform');
            if (!transform) return false;
            const signatures = checker
              .getTypeOfSymbolAtLocation(transform, declaration)
              .getCallSignatures();
            if (signatures.length !== 1 || !signatures[0].parameters.length)
              return false;
            const signature = signatures[0];
            const input = checker.getTypeOfSymbolAtLocation(
              signature.parameters[0],
              declaration,
            );
            if (previous && !checker.isTypeAssignableTo(previous, input))
              return false;
            const output = checker.getAwaitedType(
              checker.getReturnTypeOfSignature(signature),
            );
            if (!output || selectedShape(output) === 'unknown') return false;
            previous = output;
          }
          return (
            !previous || checker.isTypeAssignableTo(previous, parameterType)
          );
        }
        function parameter(node) {
          for (const decorator of decorators(node)) {
            const name = decoratorName(decorator);
            if (!name) {
              report(decorator, 'boundary');
              continue;
            }
            if (!Object.hasOwn(inputRoles, name)) continue;
            const expression = decorator.expression;
            if (!ts.isCallExpression(expression)) {
              report(decorator, 'boundary');
              continue;
            }
            const selector = expression.arguments[0];
            const selected =
              selector &&
              ts.isStringLiteral(selector) &&
              selector.text.length > 0;
            if (
              selector &&
              !ts.isStringLiteral(selector) &&
              !(ts.isIdentifier(selector) && selector.text === 'undefined')
            ) {
              report(decorator, 'boundary');
              continue;
            }
            const typeNode = node.type;
            if (selected) {
              const parameterType = checker.getTypeAtLocation(node);
              const shape = selectedShape(parameterType);
              const pipeSupported = selectedPipes(
                expression.arguments.slice(1),
                parameterType,
              );
              if (shape === 'unknown' || !pipeSupported)
                report(node, 'boundary');
              if (shape === 'unknown' || shape === 'scalar') continue;
            }
            const local =
              typeNode && ts.isTypeReferenceNode(typeNode)
                ? checker.getSymbolAtLocation(typeNode.typeName)
                : undefined;
            const symbol = canonical(local);
            const declaration = symbol?.declarations?.find(
              (item) =>
                ts.isClassDeclaration(item) ||
                ts.isInterfaceDeclaration(item) ||
                ts.isTypeAliasDeclaration(item),
            );
            const data = { binding: name, inputRole: inputRoles[name] };
            if (!declaration) {
              report(node, 'dto', data);
              continue;
            }
            const owner = normalized(declaration.getSourceFile().fileName);
            const sourceDomain = ownedDomain(filename);
            const dtoDomain = ownedDomain(owner);
            const exported = declaration.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            );
            const type = checker.getTypeAtLocation(typeNode);
            const members = type.isUnion() ? type.types : [type];
            const unsafe = members.some(
              (member) => !(member.flags & ts.TypeFlags.Object),
            );
            const alias =
              ts.isTypeAliasDeclaration(declaration) &&
              !ts.isTypeLiteralNode(declaration.type) &&
              !ts.isUnionTypeNode(declaration.type);
            const correctFile = new RegExp(
              `/dto/[^/]+-${inputRoles[name]}\\.dto\\.[cm]?tsx?$`,
            ).test(owner);
            if (
              !exported ||
              !symbol.name.endsWith('Dto') ||
              !correctFile ||
              !sourceDomain ||
              !dtoDomain ||
              sourceDomain !== dtoDomain ||
              unsafe ||
              alias ||
              (ts.isClassDeclaration(declaration) &&
                (role(declaration) || registrations.has(symbol)))
            )
              report(node, 'dto', data);
            if (ts.isClassDeclaration(declaration)) {
              let rootName = typeNode.typeName;
              while (ts.isQualifiedName(rootName)) rootName = rootName.left;
              if (
                typeOnly(local) ||
                typeOnly(checker.getSymbolAtLocation(rootName))
              )
                report(node, 'metadata', { name: symbol.name });
            }
          }
        }
        function visit(node) {
          const call = operation(node);
          if (call) {
            // Only a decorator's own invocation is framework plumbing. Its
            // argument expressions are ordinary code owned by the decorated
            // declaration, so they keep their effect checks.
            const inDecorator =
              ts.isDecorator(node.parent) && node.parent.expression === node;
            let enclosing = node.parent;
            while (enclosing && !ts.isClassDeclaration(enclosing))
              enclosing = enclosing.parent;
            const owner =
              enclosing && ts.isClassDeclaration(enclosing)
                ? role(enclosing)
                : exportedImplementation
                  ? canonicalFunctionalRole
                  : undefined;
            // Resolved Nest/provider ownership does not disappear when a class
            // needs relocation. Placement is diagnosed independently; classless
            // functional ownership still requires its canonical role location.
            const recognizedOwner =
              enclosing && ts.isClassDeclaration(enclosing)
                ? Boolean(owner)
                : Boolean(
                    owner &&
                    filename.includes(`/${roleDirectories[owner]}/`) &&
                    new RegExp(`\\.${owner}\\.[cm]?tsx?$`).test(filename),
                  );
            const permittedOwner =
              recognizedOwner && (!contextOnly || contextOperations.has(node));
            const infrastructure =
              enclosing &&
              ts.isClassDeclaration(enclosing) &&
              infrastructureOwner(enclosing);
            const composition =
              bootstrapOperation(node, call) || scopeContinuation(node, call);
            const transportTimer = call.effect === 'timer' && sseLifetime(node);
            if (
              !inDecorator &&
              call.effect &&
              !infrastructure &&
              !composition &&
              !transportTimer
            ) {
              const filesystemRepository =
                call.effect === 'filesystem' &&
                owner === 'repository' &&
                filename.includes(`/${roleDirectories.repository}/`) &&
                /\.repository\.[cm]?tsx?$/.test(filename);
              const allowed =
                call.effect === 'persistence' || filesystemRepository
                  ? ['service', 'repository', 'adapter']
                  : call.effect === 'HTTP transport'
                    ? ['controller', 'service', 'adapter', 'guard', 'filter']
                    : ['service', 'adapter'];
              if (!permittedOwner || !allowed.includes(owner))
                report(node, 'io', { effect: call.effect, name: call.name });
            } else if (
              !inDecorator &&
              !call.effect &&
              !infrastructure &&
              !composition &&
              !permittedOwner
            ) {
              // No general dataflow inference: an opaque producer in a helper
              // or unowned functional module must not silently become "pure".
              const helperSurface =
                (contextOnly || !roles.size) &&
                (!classes.length ||
                  (enclosing && auxiliaryRoles.get(enclosing) === 'helper'));
              if (helperSurface && !computational(node))
                report(node, 'effect', { name: call.name });
            }
          }
          if (
            dtoModule &&
            (ts.isClassDeclaration(node) ||
              ts.isInterfaceDeclaration(node) ||
              ts.isTypeAliasDeclaration(node)) &&
            node.name?.text.endsWith('Dto') &&
            !dtoFile.test(filename)
          )
            report(node, 'dtoPlacement', { name: node.name.text });
          if (unsupportedModules.has(node)) report(node, 'module');
          if (ts.isClassExpression(node))
            report(node, 'role', {
              name: node.name?.text ?? '<class expression>',
            });
          if (ts.isParameter(node) && !ts.isConstructorDeclaration(node.parent))
            parameter(node);
          if (
            ts.isParameter(node) &&
            ts.isConstructorDeclaration(node.parent) &&
            role(node.parent.parent)
          ) {
            const owner = symbolAt(node.parent.parent.name);
            const manuallyConstructed =
              (factoryConstruction.has(owner) || manualServices.has(owner)) &&
              !automaticConstruction.has(owner) &&
              !(
                manualServices.has(owner) &&
                decorators(node.parent.parent).some(
                  (decorator) => decoratorName(decorator) === 'Injectable',
                )
              );
            const explicitToken = decorators(node).some(
              (decorator) => decoratorName(decorator) === 'Inject',
            );
            if (!explicitToken && !manuallyConstructed) {
              const declaration = node.parent.parent;
              const constructorDecorated =
                decorators(declaration).length > 0 ||
                node.parent.parameters.some(
                  (parameter) => decorators(parameter).length > 0,
                );
              const constructorMetadata =
                services.program.getCompilerOptions().emitDecoratorMetadata ===
                  true && constructorDecorated;
              const metadataFreeDefault =
                !constructorDecorated &&
                !explicitMetadata.has(owner) &&
                !declaration.heritageClauses?.some(
                  (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
                ) &&
                !declaration.members.some(
                  (member) =>
                    ts.isClassStaticBlockDeclaration(member) ||
                    decorators(member).length > 0 ||
                    member.modifiers?.some(
                      (modifier) =>
                        modifier.kind === ts.SyntaxKind.StaticKeyword,
                    ) ||
                    member.parameters?.some(
                      (parameter) => decorators(parameter).length > 0,
                    ),
                ) &&
                Boolean(node.initializer || node.questionToken);
              const local =
                node.type && ts.isTypeReferenceNode(node.type)
                  ? checker.getSymbolAtLocation(node.type.typeName)
                  : undefined;
              if (
                !metadataFreeDefault &&
                (!constructorMetadata ||
                  !canonical(local)?.declarations?.some(
                    ts.isClassDeclaration,
                  ) ||
                  typeOnly(local))
              )
                report(node, 'di');
            }
          }
          if (ts.isIdentifier(node))
            inspectSymbol(checker.getSymbolAtLocation(node), node);
          if (
            ts.isImportSpecifier(node) &&
            !symbolAt(node.name)?.declarations?.length
          )
            report(node, 'unresolved', { name: node.name.text });
          if (ts.isElementAccessExpression(node)) {
            const owner = symbolAt(node.expression);
            if (owner?.declarations?.some(ts.isSourceFile))
              report(node, 'unresolved', { name: node.getText() });
          }
          if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            if (node.moduleSpecifier) {
              const module = symbolAt(node.moduleSpecifier);
              if (!module)
                report(node, 'unresolved', {
                  name: node.moduleSpecifier.getText(),
                });
              // Bare exports/imports otherwise have no referenced member node.
              if (
                module &&
                ((ts.isExportDeclaration(node) && !node.exportClause) ||
                  (ts.isImportDeclaration(node) && !node.importClause))
              ) {
                for (const member of checker.getExportsOfModule(module))
                  inspectSymbol(member, node);
              }
            }
          }
          if (ts.isImportEqualsDeclaration(node))
            report(node, 'unresolved', { name: node.name.text });
          if (
            ts.isCallExpression(node) &&
            (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(node.expression) &&
                node.expression.text === 'require'))
          ) {
            // TS resolves ordinary imports; loading a namespace at runtime can
            // escape its boundary. No guessed require/import value-flow model.
            report(node, 'unresolved', { name: node.getText() });
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
      },
    };
  },
};

export default { rules: { boundaries: rule } };
