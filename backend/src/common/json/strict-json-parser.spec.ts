import { parseStrictJson, StrictJsonError } from './strict-json-parser.js';

describe('strict JSON parser', () => {
  it.each([
    '{"outer":{"key":1,"key":2}}',
    '[{"key":1,"key":2}]',
    '{"key":1,"\\u006bey":2}',
  ])('rejects duplicate keys at every object depth', (json) => {
    expect(() => parseStrictJson(Buffer.from(json))).toThrow(StrictJsonError);
  });

  it('rejects malformed UTF-8 and unpaired Unicode surrogates', () => {
    expect(() => parseStrictJson(Buffer.from([0xc3, 0x28]))).toThrow(
      StrictJsonError,
    );
    expect(() => parseStrictJson(Buffer.from('{"value":"\\ud800"}'))).toThrow(
      StrictJsonError,
    );
  });

  it('rejects numbers that cannot be represented finitely', () => {
    expect(() => parseStrictJson(Buffer.from('{"value":1e400}'))).toThrow(
      StrictJsonError,
    );
  });

  it('returns the parsed value with an unchanged byte copy', () => {
    const bytes = Buffer.from('{"value":1}');
    const parsed = parseStrictJson(bytes);
    expect(parsed.value).toEqual({ value: 1 });
    expect(parsed.originalBytes).toEqual(bytes);
    expect(parsed.originalBytes).not.toBe(bytes);
  });
});
