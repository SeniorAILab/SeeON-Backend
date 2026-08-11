import { chmod, writeFile } from 'node:fs/promises';
import {
  readObject,
  readObjectField,
  readStringField,
} from './json-response.js';

export type IssuedCredential = {
  readonly idempotencyKey: string;
  readonly operationId: string;
  readonly facilityCode: string;
  readonly installationId: string;
  readonly tokenId: string;
  readonly token: string;
};

export class CloudEdgeHttpClient {
  readonly aiUrl = required('CLOUD_EDGE_AI_URL');
  readonly mlUrl = required('CLOUD_EDGE_ML_URL');
  private readonly relayToken = required('CLOUD_EDGE_RELAY_TOKEN');
  private mlCookie: string | null = null;
  private sequence = 0;

  async expectHealthy(): Promise<void> {
    expect(
      await fetch(`${this.aiUrl}/health`).then((response) => response.status),
    ).toBe(200);
    expect(
      await fetch(`${this.mlUrl}/health/ready`).then(
        (response) => response.status,
      ),
    ).toBe(200);
  }

  async login(email: string, password: string): Promise<string> {
    const response = await fetch(`${this.aiUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({ email, password }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (cookie === undefined) throw new Error('session cookie missing');
    return cookie;
  }

  async loginMl(): Promise<void> {
    const response = await fetch(`${this.mlUrl}/api/v1/auth/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: json({
        username: required('CLOUD_EDGE_ML_DASHBOARD_USERNAME'),
        password: required('CLOUD_EDGE_ML_DASHBOARD_PASSWORD'),
      }),
    });
    await expectStatus(response, 204, '/api/v1/auth/session');
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (cookie === undefined) throw new Error('ML dashboard cookie missing');
    this.mlCookie = cookie;
  }

  async issue(cookie: string, facilityId: string): Promise<IssuedCredential> {
    const idempotencyKey = this.uuidV7();
    const body = readObject(
      await this.issueWithKey(cookie, facilityId, idempotencyKey),
      'issue response',
    );
    const oneTime = readObjectField(body, 'oneTimeDisplay');
    return {
      idempotencyKey,
      operationId: readStringField(body, 'operationId'),
      facilityCode: readStringField(body, 'facilityCode'),
      installationId: readStringField(body, 'edgeInstallationId'),
      tokenId: readStringField(oneTime, 'tokenId'),
      token: readStringField(oneTime, 'value'),
    };
  }

  issueWithKey(
    cookie: string,
    facilityId: string,
    key: string,
  ): Promise<unknown> {
    return this.ai(
      '/api/v1/admin/edge-credentials',
      {
        method: 'POST',
        headers: { cookie, 'idempotency-key': key },
        body: json({ schemaVersion: 1, facilityId }),
      },
      201,
    );
  }

  async verify(
    issued: IssuedCredential,
    ref: string,
    status: number,
  ): Promise<void> {
    await this.ai(
      '/api/v1/edge/enrollments/verify',
      {
        method: 'POST',
        headers: bearer(issued.token),
        body: json({
          schemaVersion: 1,
          facilityCode: issued.facilityCode,
          clientInstallationRef: ref,
        }),
      },
      status,
    );
  }

  async ai(path: string, init: RequestInit, status: number): Promise<unknown> {
    const response = await fetch(`${this.aiUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    await expectStatus(response, status, path);
    return status === 204 ? null : response.json();
  }

  async ml(path: string, init: RequestInit, status: number): Promise<unknown> {
    const response = await fetch(`${this.mlUrl}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-edge-relay-token': this.relayToken,
        ...(this.mlCookie === null ? {} : { cookie: this.mlCookie }),
        ...init.headers,
      },
    });
    await expectStatus(response, status, path);
    return status === 204 ? null : response.json();
  }

  async writeSecretHandoff(
    facilityCode: string,
    token: string,
    ref: string,
  ): Promise<void> {
    const path = required('CLOUD_EDGE_SECRET_HANDOFF_PATH');
    await writeFile(
      path,
      JSON.stringify({ facilityCode, token, installationRef: ref }),
      {
        mode: 0o600,
      },
    );
    await chmod(path, 0o600);
  }

  uuidV7(): string {
    this.sequence += 1;
    return `0197f671-3a31-7a6c-a6e4-${this.sequence.toString(16).padStart(12, '0')}`;
  }

  uuidV4(): string {
    this.sequence += 1;
    return `8b0f5ba2-d359-4d8e-948f-${this.sequence.toString(16).padStart(12, '0')}`;
  }
}

async function expectStatus(
  response: Response,
  expected: number,
  path: string,
): Promise<void> {
  if (response.status === expected) return;
  const detail = response.status >= 400 ? await response.text() : '<redacted>';
  throw new Error(
    `${path}: expected HTTP ${expected}, received ${response.status}: ${detail}`,
  );
}

export function json(value: object): string {
  return JSON.stringify(value);
}

export function bearer(token: string): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0)
    throw new Error(`${name} is required`);
  return value;
}
