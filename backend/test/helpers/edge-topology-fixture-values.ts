export const FACILITY_ID = 'a5ff4ed1-7e63-4a4f-9ef0-42e807d74a64';
export const OTHER_FACILITY_ID = 'b5ff4ed1-7e63-4a4f-9ef0-42e807d74a64';
export const INSTALLATION_ID = 'c72bd9a7-3e04-47ba-a8cd-a56e54f98152';
export const OTHER_INSTALLATION_ID = 'd72bd9a7-3e04-47ba-a8cd-a56e54f98152';
export const PRODUCT_FLOOR_ID = 'f1111111-1111-4111-8111-111111111111';
export const PRODUCT_ROOM_ID = 'a2222222-2222-4222-8222-222222222222';
export const PRODUCT_CAMERA_ID = 'b3333333-3333-4333-8333-333333333333';
export const SNAPSHOT_ID = '0197f671-3a31-7a6c-a6e4-83ed412de81a';
export const TOKEN = `eft_v1.0123456789AB.${'A'.repeat(43)}`;

// Hub-seeded ids in real facilities are opaque strings (e.g. "sp_201"), not
// UUIDs — this fixture proves the DTO accepts them and exercises multi-room
// legacy claims on a single PRODUCT floor.
export const MULTI_PRODUCT_FLOOR_ID = 'flr_101';
export const MULTI_PRODUCT_ROOM_ID_1 = 'sp_201';
export const MULTI_PRODUCT_ROOM_ID_2 = 'sp_202';
export const MULTI_PRODUCT_CAMERA_ID_1 = 'cam_201';
export const MULTI_PRODUCT_CAMERA_ID_2 = 'cam_202';
