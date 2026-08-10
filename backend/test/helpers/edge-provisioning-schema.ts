import { readFileSync } from 'node:fs';
export type Json = Record<string, unknown>;
export type SchemaCheck = {
  readonly name: string;
  readonly field: string;
  readonly expected: readonly string[] | string;
  readonly contains?: boolean;
};
export function loadArtifacts(openApiPath: string, fixturesPath: string) {
  return {
    openApi: record(
      JSON.parse(readFileSync(openApiPath, 'utf8')),
      'OpenAPI contract',
    ),
    fixtures: record(
      JSON.parse(readFileSync(fixturesPath, 'utf8')),
      'fixture corpus',
    ),
  };
}
export function record(value: unknown, label: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${label} must be an object`);
  return Object.fromEntries(Object.entries(value));
}
export function string(value: unknown, label: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`${label} must be a string`);
  return value;
}
function strings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))
    throw new TypeError(`${label} must be a string array`);
  return value.filter((item): item is string => typeof item === 'string');
}
export function expectSchemaCheck(schemas: Json, check: SchemaCheck): void {
  const actual = record(schemas[check.name], check.name)[check.field];
  if (typeof check.expected === 'string')
    return void expect(string(actual, `${check.name} ${check.field}`)).toBe(
      check.expected,
    );
  const values = strings(actual, `${check.name} ${check.field}`);
  expect(values).toEqual(
    check.contains ? expect.arrayContaining(check.expected) : check.expected,
  );
}
export function assertNoRawCredential(value: unknown, path = 'fixture'): void {
  if (typeof value === 'string')
    return void expect(value).not.toMatch(
      /(?:eft_v1\.[^.]+\.[A-Za-z0-9_-]+|rtsp:\/\/)/i,
    );
  if (Array.isArray(value))
    return void value.forEach((item) => assertNoRawCredential(item, path));
  if (typeof value !== 'object' || value === null) return;
  for (const [key, nested] of Object.entries(value)) {
    expect(`${path}.${key}`).not.toMatch(
      /(?:password|secret|credential|token)$/i,
    );
    assertNoRawCredential(nested, `${path}.${key}`);
  }
}
export function openApiOperation(
  openApi: Json,
  method: string,
  path: string,
): Json {
  const operation = record(record(openApi.paths, 'OpenAPI paths')[path], path)[
    method
  ];
  if (operation === undefined)
    throw new TypeError(`${method} ${path} is missing`);
  return record(operation, `${method} ${path}`);
}
export function validateFixture(
  operation: Json,
  fixture: Json,
  openApi: Json,
  label: string,
): void {
  const request = record(fixture.request, `${label} request`);
  const requestSchema = schemaAt(operation.requestBody, openApi);
  if (requestSchema !== undefined)
    validate(requestSchema, request.body, openApi, `${label} request body`);
  const response = record(fixture.response, `${label} response`);
  const status = string(fixture.successStatus, `${label} successStatus`);
  if (hasBinaryResponse(operation, openApi))
    return validateBinary(response, label);
  validate(
    schemaAt(
      record(operation.responses, `${label} responses`)[status],
      openApi,
    ),
    response,
    openApi,
    `${label} response`,
  );
  validateResultVariants(operation, fixture.resultVariants, openApi, label);
}
function validateResultVariants(
  operation: Json,
  variantsValue: unknown,
  openApi: Json,
  label: string,
): void {
  if (variantsValue === undefined) return;
  const variants = record(variantsValue, `${label} resultVariants`);
  const responses = record(operation.responses, `${label} responses`);
  for (const [name, value] of Object.entries(variants)) {
    const variant = record(value, `${label} resultVariants.${name}`);
    const status = string(
      variant.successStatus,
      `${label} resultVariants.${name} successStatus`,
    );
    if (responses[status] === undefined)
      throw new TypeError(
        `${label} resultVariants.${name} uses undeclared response ${status}`,
      );
    const response = record(
      variant.response,
      `${label} resultVariants.${name} response`,
    );
    validate(
      schemaAt(responses[status], openApi),
      response,
      openApi,
      `${label} resultVariants.${name} response`,
    );
  }
}
function hasBinaryResponse(operation: Json, openApi: Json): boolean {
  const responses = record(operation.responses, 'responses');
  return Object.values(responses).some((response) => {
    const entry = deref(record(response, 'response'), openApi);
    if (entry.content === undefined) return false;
    const content = record(entry.content, 'response content');
    return content['video/mp4'] !== undefined;
  });
}
function validateBinary(response: Json, label: string): void {
  const headers = record(response.headers, `${label} headers`);
  expect(
    string(headers['Content-Disposition'], `${label} content disposition`),
  ).toMatch(/^attachment; filename="[^"]+\.mp4"$/);
  expect(headers['Accept-Ranges']).toBe('bytes');
  expect(headers['Cache-Control']).toBe('private, no-store, no-transform');
  expect(string(headers.ETag, `${label} etag`)).toMatch(
    /^"sha256-[a-f0-9]{64}"$/,
  );
  expect(headers['Content-Length']).toBe(1024);
  if (response.bodyState === 'omitted')
    return expect(response.auditOutcome).toBe('NOT_CREATED');
  const body = record(response.body, `${label} body`);
  expect(body.mediaState).toBe('binary-redacted');
  expect(body.byteLength).toBe(headers['Content-Length']);
  expect(response.auditOutcome).toBe('COMPLETED');
}
function schemaAt(value: unknown, openApi: Json): Json | undefined {
  if (value === undefined) return undefined;
  const entry = deref(record(value, 'OpenAPI entry'), openApi);
  if (entry.content === undefined) return entry;
  const media = record(entry.content, 'OpenAPI content');
  const json =
    media['application/json'] ?? media['image/jpeg'] ?? media['video/mp4'];
  return json === undefined
    ? undefined
    : deref(
        record(record(json, 'OpenAPI media').schema, 'OpenAPI media schema'),
        openApi,
      );
}
function deref(schema: Json, openApi: Json): Json {
  const ref = schema.$ref;
  if (typeof ref !== 'string') return schema;
  const name = ref.split('/').at(-1);
  const components = record(openApi.components, 'components');
  const group = ref.includes('/responses/') ? 'responses' : 'schemas';
  return record(
    record(components[group], group)[string(name, 'schema ref')],
    ref,
  );
}
function validate(
  schema: Json | undefined,
  value: unknown,
  openApi: Json,
  label: string,
): void {
  if (schema === undefined) return;
  const resolved = deref(schema, openApi);
  const type = resolved.type;
  if (type === 'string') expect(typeof value).toBe('string');
  if (type === 'integer') expect(Number.isInteger(value)).toBe(true);
  if (type === 'number') expect(typeof value).toBe('number');
  if (type === 'boolean') expect(typeof value).toBe('boolean');
  if (typeof resolved.pattern === 'string')
    expect(string(value, label)).toMatch(new RegExp(resolved.pattern));
  if (Array.isArray(resolved.enum)) expect(resolved.enum).toContain(value);
  if (Array.isArray(value) && resolved.items !== undefined)
    value.forEach((item, index) =>
      validate(
        record(resolved.items, `${label} items`),
        item,
        openApi,
        `${label}[${index}]`,
      ),
    );
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return;
  const object = record(value, label);
  for (const key of strings(resolved.required ?? [], `${label} required`))
    expect(object[key]).toBeDefined();
  const properties = record(resolved.properties ?? {}, `${label} properties`);
  if (resolved.additionalProperties === false)
    expect(Object.keys(object).sort()).toEqual(
      Object.keys(properties)
        .filter((key) => object[key] !== undefined)
        .sort(),
    );
  for (const [key, item] of Object.entries(object))
    if (properties[key] !== undefined)
      validate(
        record(properties[key], `${label}.${key}`),
        item,
        openApi,
        `${label}.${key}`,
      );
}
