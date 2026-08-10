import type { INestApplication } from '@nestjs/common';
import { json, type NextFunction, type Request, type Response } from 'express';
import type { IncomingMessage } from 'node:http';

export type StrictJsonValue =
  | boolean
  | null
  | number
  | string
  | StrictJsonValue[]
  | { [key: string]: StrictJsonValue };

export type StrictJsonResult = {
  readonly value: StrictJsonValue;
  readonly originalBytes: Buffer;
};

export class StrictJsonError extends Error {
  readonly name = 'StrictJsonError';
}

type StrictJsonRequest = IncomingMessage & { rawBody?: Buffer };

export function configureHttpBodyParsing(app: INestApplication): void {
  app.use(
    json({
      verify(request, _response, bytes) {
        if (!isStrictRoute(request.method ?? '', request.url ?? '')) return;
        const parsed = parseStrictJson(bytes);
        const strictRequest: StrictJsonRequest = request;
        strictRequest.rawBody = parsed.originalBytes;
      },
    }),
  );
  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ): void => {
      if (!(error instanceof StrictJsonError)) {
        next(error);
        return;
      }
      response.status(400).json({
        schemaVersion: 1,
        error: {
          code: 'INVALID_SCHEMA',
          message: 'Request does not match edge provisioning v1.',
          retryable: false,
          requestId: 'strict-json',
        },
      });
    },
  );
}

export function parseStrictJson(bytes: Uint8Array): StrictJsonResult {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const parser = new StrictJsonReader(text);
    return {
      value: parser.parse(),
      originalBytes: Buffer.from(bytes),
    };
  } catch (error: unknown) {
    if (error instanceof StrictJsonError) throw error;
    throw new StrictJsonError('invalid JSON');
  }
}

class StrictJsonReader {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): StrictJsonValue {
    const value = this.value();
    this.space();
    if (this.index !== this.text.length) this.fail();
    return value;
  }

  private value(): StrictJsonValue {
    this.space();
    const character = this.text[this.index];
    if (character === '{') return this.object();
    if (character === '[') return this.array();
    if (character === '"') return this.string();
    if (character === 't') return this.literal('true', true);
    if (character === 'f') return this.literal('false', false);
    if (character === 'n') return this.literal('null', null);
    return this.number();
  }

  private object(): { [key: string]: StrictJsonValue } {
    this.index += 1;
    const result: { [key: string]: StrictJsonValue } = {};
    const keys = new Set<string>();
    this.space();
    if (this.take('}')) return result;
    while (this.index < this.text.length) {
      this.space();
      if (this.text[this.index] !== '"') this.fail();
      const key = this.string();
      if (keys.has(key)) throw new StrictJsonError('duplicate JSON key');
      keys.add(key);
      this.space();
      if (!this.take(':')) this.fail();
      result[key] = this.value();
      this.space();
      if (this.take('}')) return result;
      if (!this.take(',')) this.fail();
    }
    return this.fail();
  }

  private array(): StrictJsonValue[] {
    this.index += 1;
    const result: StrictJsonValue[] = [];
    this.space();
    if (this.take(']')) return result;
    while (this.index < this.text.length) {
      result.push(this.value());
      this.space();
      if (this.take(']')) return result;
      if (!this.take(',')) this.fail();
    }
    return this.fail();
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      this.index += 1;
      if (!escaped && character === '"') {
        const parsed: unknown = JSON.parse(this.text.slice(start, this.index));
        if (typeof parsed !== 'string' || hasUnpairedSurrogate(parsed)) {
          throw new StrictJsonError('invalid JSON string');
        }
        return parsed;
      }
      if (!escaped && character.charCodeAt(0) < 0x20) this.fail();
      escaped = !escaped && character === '\\';
      if (character !== '\\') escaped = false;
    }
    return this.fail();
  }

  private number(): number {
    const match = this.text
      .slice(this.index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (match === null) return this.fail();
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) return this.fail();
    return value;
  }

  private literal<T extends boolean | null>(token: string, value: T): T {
    if (!this.text.startsWith(token, this.index)) return this.fail();
    this.index += token.length;
    return value;
  }

  private space(): void {
    while (' \t\r\n'.includes(this.text[this.index] ?? '\0')) this.index += 1;
  }

  private take(character: string): boolean {
    if (this.text[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private fail(): never {
    throw new StrictJsonError('invalid JSON');
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function isStrictRoute(method: string, originalUrl: string): boolean {
  const path = originalUrl.split('?', 1)[0];
  if (method === 'POST' && path === '/api/v1/edge/enrollments/verify')
    return true;
  if (/^\/api\/v1\/edge\/topology-snapshots\/[^/]+(?:\/confirm)?$/.test(path))
    return true;
  return method === 'POST' && /^\/api\/v1\/admin\/edge-/.test(path);
}
