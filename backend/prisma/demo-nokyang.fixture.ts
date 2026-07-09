import { SpaceType } from '@prisma/client';

export const NOKYANG_FACILITY_CODE = 'happy-nokyang';
export const NOKYANG_ADMIN_EMAIL = 'nokyang-admin@example.com';

export type FixtureItem = {
  readonly id: string;
};

export class DuplicateFixtureIdError extends Error {
  constructor(
    public readonly label: string,
    public readonly duplicateId: string,
  ) {
    super(`Duplicate ${label} fixture id: ${duplicateId}`);
    this.name = 'DuplicateFixtureIdError';
  }
}

export function verifyUniqueIds(
  label: string,
  items: readonly FixtureItem[],
): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new DuplicateFixtureIdError(label, item.id);
    }
    seen.add(item.id);
  }
}

export type FacilitySeed = {
  readonly name: string;
  readonly code: string;
  readonly address: string;
  readonly phone: string;
  readonly businessRegistrationNumber: string;
};

export type FloorSeed = {
  readonly id: string;
  readonly name: string;
  readonly orderIndex: number;
};

export type SpaceSeed = {
  readonly id: string;
  readonly floorId: string;
  readonly name: string;
  readonly type: SpaceType;
  readonly capacity: number;
  readonly assignedStaff: string;
};

export type CameraSeed = {
  readonly id: string;
  readonly spaceId: string;
  readonly label: string;
};

export const nokyangFacility: FacilitySeed = {
  name: '행복한요양원 녹양역점',
  code: 'happy-nokyang',
  address: '경기도 의정부시 녹양로 12',
  phone: '031-123-4567',
  businessRegistrationNumber: '123-45-67890',
};

export const nokyangFloors: readonly FloorSeed[] = [
  { id: 'fl_b1', name: 'B1', orderIndex: 0 },
  { id: 'fl_1f', name: '1F', orderIndex: 1 },
  { id: 'fl_2f', name: '2F', orderIndex: 2 },
  { id: 'fl_3f', name: '3F', orderIndex: 3 },
  { id: 'fl_4f', name: '4F', orderIndex: 4 },
];

function space(
  id: string,
  floorId: string,
  name: string,
  type: SpaceType,
  capacity: number,
  assignedStaff: string,
): SpaceSeed {
  return {
    id,
    floorId,
    name,
    type,
    capacity,
    assignedStaff,
  };
}

function residentialFloor(
  floorNumber: number,
  staff: string,
): readonly SpaceSeed[] {
  const floorId = `fl_${floorNumber}f`;
  const rooms = Array.from({ length: 10 }, (_, index) => {
    const roomNumber = `${floorNumber}${String(index + 1).padStart(2, '0')}`;
    return space(
      `sp_${roomNumber}`,
      floorId,
      `${roomNumber}호`,
      SpaceType.ROOM,
      4,
      staff,
    );
  });
  return [
    ...rooms,
    space(
      `sp_${floorNumber}f_hc`,
      floorId,
      '중앙복도',
      SpaceType.HALLWAY,
      10,
      staff,
    ),
    space(
      `sp_${floorNumber}f_hl`,
      floorId,
      '좌측복도',
      SpaceType.HALLWAY,
      8,
      staff,
    ),
    space(
      `sp_${floorNumber}f_hr`,
      floorId,
      '우측복도',
      SpaceType.HALLWAY,
      8,
      staff,
    ),
    space(
      `sp_${floorNumber}f_prog`,
      floorId,
      '프로그램실',
      SpaceType.PROGRAM_ROOM,
      20,
      staff,
    ),
  ];
}

export const nokyangSpaces: readonly SpaceSeed[] = [
  space('sp_b1_pt', 'fl_b1', '물리치료실', SpaceType.REHAB_ROOM, 8, '정재활'),
  space(
    'sp_b1_prog',
    'fl_b1',
    '프로그램실',
    SpaceType.PROGRAM_ROOM,
    20,
    '한복지',
  ),
  space('sp_b1_dining', 'fl_b1', '식당', SpaceType.DINING, 40, '한복지'),
  space('sp_b1_hall', 'fl_b1', '복도', SpaceType.HALLWAY, 10, '정재활'),
  space('sp_b1_store', 'fl_b1', '창고', SpaceType.STORAGE, 2, '관리팀'),
  space(
    'sp_b1_staff',
    'fl_b1',
    '직원휴게공간',
    SpaceType.STAFF_LOUNGE,
    8,
    '관리팀',
  ),
  space('sp_1f_lobby', 'fl_1f', '로비', SpaceType.LOBBY, 30, '안내데스크'),
  space('sp_1f_counsel', 'fl_1f', '상담실', SpaceType.OFFICE, 6, '김원장'),
  space('sp_1f_office', 'fl_1f', '사무실', SpaceType.OFFICE, 6, '관리팀'),
  space(
    'sp_1f_nurse',
    'fl_1f',
    '간호스테이션',
    SpaceType.NURSE_STATION,
    4,
    '이간호',
  ),
  space('sp_1f_hall', 'fl_1f', '중앙복도', SpaceType.HALLWAY, 12, '이간호'),
  space(
    'sp_1f_entrance',
    'fl_1f',
    '출입구',
    SpaceType.ENTRANCE,
    6,
    '안내데스크',
  ),
  ...residentialFloor(2, '이간호'),
  ...residentialFloor(3, '최요양'),
  ...residentialFloor(4, '윤케어'),
];

export const nokyangCameras: readonly CameraSeed[] = [
  {
    id: 'cam_sp_205',
    spaceId: 'sp_205',
    label: 'CAM-2F-205',
  },
  {
    id: 'cam_sp_2f_prog',
    spaceId: 'sp_2f_prog',
    label: 'CAM-2F-PROG',
  },
  {
    id: 'cam_sp_202',
    spaceId: 'sp_202',
    label: 'CAM-2F-202',
  },
  {
    id: 'cam_sp_203',
    spaceId: 'sp_203',
    label: 'CAM-2F-203',
  },
  {
    id: 'cam_sp_301',
    spaceId: 'sp_301',
    label: 'CAM-3F-301',
  },
  {
    id: 'cam_sp_305',
    spaceId: 'sp_305',
    label: 'CAM-3F-305',
  },
  {
    id: 'cam_sp_401',
    spaceId: 'sp_401',
    label: 'CAM-4F-401',
  },
];

export function verifyNokyangFixture(): void {
  verifyUniqueIds('floors', nokyangFloors);
  verifyUniqueIds('spaces', nokyangSpaces);
  verifyUniqueIds('cameras', nokyangCameras);
}
