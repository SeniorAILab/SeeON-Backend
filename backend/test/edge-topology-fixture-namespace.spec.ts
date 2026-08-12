import {
  nokyangCameras,
  nokyangFloors,
  nokyangSpaces,
} from '../prisma/demo-nokyang.fixture';
import {
  MULTI_PRODUCT_CAMERA_ID_1,
  MULTI_PRODUCT_CAMERA_ID_2,
  MULTI_PRODUCT_FLOOR_ID,
  MULTI_PRODUCT_ROOM_ID_1,
  MULTI_PRODUCT_ROOM_ID_2,
  PRODUCT_CAMERA_ID,
  PRODUCT_FLOOR_ID,
  PRODUCT_ROOM_ID,
} from './helpers/edge-topology-fixture-values';

// `Floor.id`, `Space.id`, and `Camera.id` are global (non-facility-scoped)
// primary keys (prisma/schema.prisma). `prisma/demo-nokyang.fixture.ts` seeds
// real-looking opaque ids (`sp_201`, `sp_202`, ...) into any DB touched by
// `pnpm dev:backend:fresh` / `prisma:reset:local` / `db:seed:prod`. If an
// edge-topology test fixture ever mints the same literal id, seeding then
// running `pnpm --filter backend test` deterministically fails with a
// Postgres unique-constraint violation on the shared primary key, because
// two unrelated facilities' rows fight over one global id
// (see `backend/test/helpers/edge-topology-db-fixture.ts`'s
// `seedMultiRoomProductTopology`, which inserts these fixture ids verbatim).
//
// This regression pins the fixture ids out of the nokyang seed's id space so
// that hazard cannot silently return.
describe('edge-topology fixture ids stay disjoint from the nokyang demo seed', () => {
  const nokyangFloorIds = new Set(nokyangFloors.map((floor) => floor.id));
  const nokyangSpaceIds = new Set(nokyangSpaces.map((space) => space.id));
  const nokyangCameraIds = new Set(nokyangCameras.map((camera) => camera.id));

  it('multi-room legacy-claim floor/room/camera ids are absent from the nokyang seed', () => {
    expect(nokyangFloorIds.has(MULTI_PRODUCT_FLOOR_ID)).toBe(false);
    for (const id of [MULTI_PRODUCT_ROOM_ID_1, MULTI_PRODUCT_ROOM_ID_2]) {
      expect(nokyangSpaceIds.has(id)).toBe(false);
    }
    for (const id of [MULTI_PRODUCT_CAMERA_ID_1, MULTI_PRODUCT_CAMERA_ID_2]) {
      expect(nokyangCameraIds.has(id)).toBe(false);
    }
  });

  it('single-room PRODUCT floor/room/camera ids are absent from the nokyang seed', () => {
    expect(nokyangFloorIds.has(PRODUCT_FLOOR_ID)).toBe(false);
    expect(nokyangSpaceIds.has(PRODUCT_ROOM_ID)).toBe(false);
    expect(nokyangCameraIds.has(PRODUCT_CAMERA_ID)).toBe(false);
  });
});
