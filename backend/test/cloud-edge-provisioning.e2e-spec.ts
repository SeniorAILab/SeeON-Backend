import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  CloudEdgeDbFixture,
  FACILITY_ID,
  OTHER_FACILITY_ID,
  SUPER_EMAIL,
  ADMIN_EMAIL,
  OTHER_ADMIN_EMAIL,
  PASSWORD,
} from './helpers/cloud-edge-db-fixture.js';
import {
  bearer,
  CloudEdgeHttpClient,
  json,
} from './helpers/cloud-edge-http-client.js';
import {
  readObject,
  readObjectField,
  readStringField,
} from './helpers/json-response.js';

const INSTALLATION_REF = '8b0f5ba2-d359-4d8e-948f-e386ac40c347';
const OTHER_INSTALLATION_REF = '9b0f5ba2-d359-4d8e-948f-e386ac40c347';
const FLOOR_REF = 'floor-task15';
const ROOM_REF = 'room-task15';
const CAMERA_REF = 'camera-task15';

describe('cloud edge provisioning real-service lifecycle', () => {
  const database = new CloudEdgeDbFixture();
  const http = new CloudEdgeHttpClient();

  beforeAll(() => database.start());
  afterAll(() => database.disconnect());

  it('converges, confirms omissions, preserves legacy overlap, and denies cross-tenant access', async () => {
    // Given: two isolated facilities and real AI/ML HTTP processes.
    await http.expectHealthy();
    await http.loginMl();
    const superCookie = await http.login(SUPER_EMAIL, PASSWORD);
    const adminCookie = await http.login(ADMIN_EMAIL, PASSWORD);
    const otherAdminCookie = await http.login(OTHER_ADMIN_EMAIL, PASSWORD);
    const issued = await http.issue(superCookie, FACILITY_ID);
    const otherIssued = await http.issue(superCookie, OTHER_FACILITY_ID);
    await http.verify(otherIssued, OTHER_INSTALLATION_REF, 200);
    await http.ml(
      '/api/v1/cameras/topology/floors',
      {
        method: 'POST',
        body: json({ edge_ref: FLOOR_REF, name: '2F', order_index: 2 }),
      },
      201,
    );
    await http.ml(
      '/api/v1/cameras/topology/rooms',
      {
        method: 'POST',
        body: json({
          edge_ref: ROOM_REF,
          floor_edge_ref: FLOOR_REF,
          name: '201',
        }),
      },
      201,
    );
    const camera = await createCamera('Synthetic Camera');

    // When: the technician enrolls and explicitly synchronizes the registry.
    await http.ml(
      '/api/v1/connection',
      {
        method: 'PUT',
        body: json({
          facility_code: issued.facilityCode,
          facility_token: issued.token,
          client_installation_ref: INSTALLATION_REF,
        }),
      },
      200,
    );
    await sync();
    const canonical = await database.direct.camera.findFirstOrThrow({
      where: { facilityId: FACILITY_ID, edgeRef: CAMERA_REF },
    });
    expect(canonical.isActive).toBe(true);

    // Then: omission remains active until matching explicit confirmation.
    await deleteCamera(readStringField(readObject(camera, 'camera'), 'id'));
    await sync();
    const preview = await currentPreview('preview response');
    expect((await cameraRow(canonical.id)).isActive).toBe(true);
    await confirm(preview);
    expect((await cameraRow(canonical.id)).isActive).toBe(false);

    // When: the same stable edge identity reappears and sends event/media facts.
    const restoredCamera = await createCamera('Synthetic Camera Restored');
    await sync();
    expect((await cameraRow(canonical.id)).isActive).toBe(true);
    const edgeEventRef = http.uuidV4();
    const event = readObject(
      await http.ai(
        '/api/v1/events',
        {
          method: 'POST',
          headers: bearer(issued.token),
          body: json({
            camera_id: canonical.id,
            edge_event_id: edgeEventRef,
            type: 'fall',
            detected_at: '2026-08-11T00:00:00.000Z',
            confidence: 0.99,
          }),
        },
        201,
      ),
      'event',
    );
    const eventId = readStringField(event, 'id');
    const clipPath = process.env.CLOUD_EDGE_CLIP_PATH;
    if (clipPath === undefined)
      throw new Error('CLOUD_EDGE_CLIP_PATH is required');
    const clip = await readFile(clipPath);
    await uploadClip(issued.token, canonical.id, edgeEventRef, clip);
    const alert = await database.direct.alert.findFirstOrThrow({
      where: { originEventId: eventId },
    });
    const download = await fetch(
      `${http.aiUrl}/api/v1/alerts/${alert.id}/media/download`,
      {
        headers: { cookie: adminCookie },
      },
    );
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(clip);
    expect(
      await fetch(`${http.aiUrl}/api/v1/alerts/${alert.id}/media/download`, {
        headers: { cookie: otherAdminCookie },
      }).then((response) => response.status),
    ).toBe(404);
    await http.ai(
      '/api/v1/events',
      {
        method: 'POST',
        headers: bearer(otherIssued.token),
        body: json({
          camera_id: canonical.id,
          edge_event_id: http.uuidV4(),
          type: 'fall',
          detected_at: '2026-08-11T00:00:03.000Z',
        }),
      },
      403,
    );
    await deleteCamera(
      readStringField(readObject(restoredCamera, 'restored camera'), 'id'),
    );
    await sync();
    await confirm(await currentPreview('final preview response'));

    // Then: timeout-safe replay is redacted and explicit recovery revokes the lost token.
    const replay = readObject(
      await http.issueWithKey(superCookie, FACILITY_ID, issued.idempotencyKey),
      'issue replay',
    );
    expect(readStringField(replay, 'secretDisplay')).toBe('NOT_AVAILABLE');
    const recovered = readObject(
      await http.ai(
        `/api/v1/admin/edge-operations/${issued.operationId}/recover-secret`,
        {
          method: 'POST',
          headers: { cookie: superCookie, 'idempotency-key': http.uuidV7() },
          body: json({ schemaVersion: 1, expectedTokenId: issued.tokenId }),
        },
        201,
      ),
      'recovery',
    );
    expect(readStringField(recovered, 'revokedTokenId')).toBe(issued.tokenId);
    const recoveredToken = readStringField(
      readObjectField(recovered, 'oneTimeDisplay'),
      'value',
    );
    await http.verify(issued, INSTALLATION_REF, 403);
    await http.verify(
      { ...issued, token: recoveredToken },
      INSTALLATION_REF,
      200,
    );
    await http.writeSecretHandoff(
      issued.facilityCode,
      recoveredToken,
      INSTALLATION_REF,
    );
  });

  function createCamera(label: string): Promise<unknown> {
    return http.ml(
      '/api/v1/cameras',
      {
        method: 'POST',
        body: json({
          label,
          rtsp_url: 'rtsp://127.0.0.1/task15-synthetic',
          edge_ref: CAMERA_REF,
          room_edge_ref: ROOM_REF,
        }),
      },
      201,
    );
  }

  async function deleteCamera(cameraId: string): Promise<void> {
    await http.ml(`/api/v1/cameras/${cameraId}`, { method: 'DELETE' }, 204);
  }

  async function sync(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const result = readObject(
        await http.ml(
          '/api/v1/connection/sync-cameras',
          { method: 'POST' },
          200,
        ),
        'sync response',
      );
      if (result.status === 'synced') return;
      if (
        result.status !== 'pending' ||
        result.error_class !== null ||
        result.next_retry_at !== null
      ) {
        throw new Error(
          `topology sync did not converge: ${JSON.stringify(result)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('topology sync remained in-flight');
  }

  async function currentPreview(name: string) {
    const response = readObject(
      await http.ml('/api/v1/connection/topology-preview', {}, 200),
      name,
    );
    return readObjectField(response, 'preview');
  }

  async function confirm(
    preview: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await http.ml(
      '/api/v1/connection/topology-preview/confirm',
      {
        method: 'POST',
        body: json({
          confirmation_id: readStringField(preview, 'confirmation_id'),
          digest: readStringField(preview, 'digest'),
          client_revision: preview.client_revision,
          server_revision: preview.server_revision,
        }),
      },
      200,
    );
  }

  function cameraRow(id: string) {
    return database.direct.camera.findUniqueOrThrow({ where: { id } });
  }

  async function uploadClip(
    token: string,
    cameraId: string,
    eventRef: string,
    clip: Buffer,
  ) {
    await http.ai(
      `/api/v1/events/clips/${http.uuidV4()}`,
      {
        method: 'PUT',
        headers: {
          ...bearer(token),
          'content-type': 'video/mp4',
          'x-edge-camera-id': cameraId,
          'x-edge-event-refs': JSON.stringify([eventRef]),
          'x-clip-start-at': '2026-08-11T00:00:00.000Z',
          'x-clip-end-at': '2026-08-11T00:00:01.000Z',
          'x-clip-finalized-at': '2026-08-11T00:00:02.000Z',
          'x-clip-sha256': createHash('sha256').update(clip).digest('hex'),
          'x-clip-size-bytes': String(clip.length),
          'x-clip-duration-ms': '1000',
          'x-clip-state-version': '1',
        },
        body: new Uint8Array(clip),
      },
      200,
    );
  }
});
