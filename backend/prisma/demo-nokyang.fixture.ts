import { Level, ResidentState, SpaceType, ZoneType } from '@prisma/client';

export const NOKYANG_FACILITY_ID = 'fac_happy_nokyang';
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
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly address: string;
  readonly phone: string;
  readonly businessRegistrationNumber: string;
};

export type FloorSeed = {
  readonly id: string;
  readonly facilityId: string;
  readonly name: string;
  readonly orderIndex: number;
};

export type SpaceSeed = {
  readonly id: string;
  readonly facilityId: string;
  readonly floorId: string;
  readonly name: string;
  readonly type: SpaceType;
  readonly capacity: number;
  readonly assignedStaff: string;
};

export type ZoneSeed = {
  readonly id: string;
  readonly facilityId: string;
  readonly spaceId: string;
  readonly name: string;
  readonly type: ZoneType;
  readonly orderIndex: number;
};

export type ResidentSeed = {
  readonly id: string;
  readonly facilityId: string;
  readonly name: string;
  readonly gender: string;
  readonly age: number;
  readonly diagnosisTags: readonly string[];
  readonly fallRiskBaseline: Level;
  readonly isFocusResident: boolean;
};

export type AssignmentSeed = {
  readonly id: string;
  readonly facilityId: string;
  readonly residentId: string;
  readonly spaceId: string;
  readonly zoneId: string;
  readonly startedAt: string;
};

export type GuardianSeed = {
  readonly id: string;
  readonly facilityId: string;
  readonly residentId: string;
  readonly name: string;
  readonly phone: string;
  readonly relation: string;
};

export type CameraSeed = {
  readonly id: string;
  readonly facilityId: string;
  readonly spaceId: string;
  readonly label: string;
};

export type ResidentStatusSeed = {
  readonly id: string;
  readonly facilityId: string;
  readonly residentId: string;
  readonly state: ResidentState;
  readonly cameraOnline: boolean;
  readonly sourceId: string;
};

export const nokyangFacility: FacilitySeed = {
  id: NOKYANG_FACILITY_ID,
  name: '행복한요양원 녹양역점',
  code: 'happy-nokyang',
  address: '경기도 의정부시 녹양로 12',
  phone: '031-123-4567',
  businessRegistrationNumber: '123-45-67890',
};

export const nokyangFloors: readonly FloorSeed[] = [
  { id: 'fl_b1', facilityId: NOKYANG_FACILITY_ID, name: 'B1', orderIndex: 0 },
  { id: 'fl_1f', facilityId: NOKYANG_FACILITY_ID, name: '1F', orderIndex: 1 },
  { id: 'fl_2f', facilityId: NOKYANG_FACILITY_ID, name: '2F', orderIndex: 2 },
  { id: 'fl_3f', facilityId: NOKYANG_FACILITY_ID, name: '3F', orderIndex: 3 },
  { id: 'fl_4f', facilityId: NOKYANG_FACILITY_ID, name: '4F', orderIndex: 4 },
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
    facilityId: NOKYANG_FACILITY_ID,
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

export const nokyangZones: readonly ZoneSeed[] = nokyangSpaces
  .filter((item) => item.type === SpaceType.ROOM)
  .flatMap((item) => [
    {
      id: `zone_${item.id}_a`,
      facilityId: NOKYANG_FACILITY_ID,
      spaceId: item.id,
      name: '침대A',
      type: ZoneType.BED,
      orderIndex: 0,
    },
    {
      id: `zone_${item.id}_b`,
      facilityId: NOKYANG_FACILITY_ID,
      spaceId: item.id,
      name: '침대B',
      type: ZoneType.BED,
      orderIndex: 1,
    },
  ]);

export const nokyangResidents: readonly ResidentSeed[] = [
  {
    id: 'res_kim',
    facilityId: NOKYANG_FACILITY_ID,
    name: '김○○',
    gender: 'F',
    age: 82,
    diagnosisTags: ['파킨슨', '치매'],
    fallRiskBaseline: Level.HIGH,
    isFocusResident: true,
  },
  {
    id: 'res_lee',
    facilityId: NOKYANG_FACILITY_ID,
    name: '이○○',
    gender: 'F',
    age: 79,
    diagnosisTags: ['치매'],
    fallRiskBaseline: Level.MEDIUM,
    isFocusResident: true,
  },
  {
    id: 'res_park',
    facilityId: NOKYANG_FACILITY_ID,
    name: '박○○',
    gender: 'M',
    age: 85,
    diagnosisTags: ['보행 불안정'],
    fallRiskBaseline: Level.MEDIUM,
    isFocusResident: true,
  },
  {
    id: 'res_choi',
    facilityId: NOKYANG_FACILITY_ID,
    name: '최○○',
    gender: 'F',
    age: 77,
    diagnosisTags: ['고혈압'],
    fallRiskBaseline: Level.LOW,
    isFocusResident: false,
  },
  {
    id: 'res_jung',
    facilityId: NOKYANG_FACILITY_ID,
    name: '정○○',
    gender: 'M',
    age: 81,
    diagnosisTags: ['당뇨'],
    fallRiskBaseline: Level.LOW,
    isFocusResident: false,
  },
];

function assignment(
  residentId: string,
  spaceId: string,
  bed: 'a' | 'b',
): AssignmentSeed {
  return {
    id: `asg_${residentId}`,
    facilityId: NOKYANG_FACILITY_ID,
    residentId,
    spaceId,
    zoneId: `zone_${spaceId}_${bed}`,
    startedAt: '2026-01-02T09:00:00+09:00',
  };
}

export const nokyangAssignments: readonly AssignmentSeed[] = [
  assignment('res_kim', 'sp_202', 'a'),
  assignment('res_lee', 'sp_203', 'a'),
  assignment('res_park', 'sp_401', 'a'),
  assignment('res_choi', 'sp_301', 'a'),
  assignment('res_jung', 'sp_305', 'a'),
];

export const nokyangGuardians: readonly GuardianSeed[] = [
  {
    id: 'grd_res_kim',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_kim',
    name: '김보호자',
    phone: '010-1111-2002',
    relation: '자녀',
  },
  {
    id: 'grd_res_lee',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_lee',
    name: '이보호자',
    phone: '010-1111-2003',
    relation: '자녀',
  },
  {
    id: 'grd_res_park',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_park',
    name: '박보호자',
    phone: '010-1111-2401',
    relation: '배우자',
  },
  {
    id: 'grd_res_choi',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_choi',
    name: '최보호자',
    phone: '010-1111-2301',
    relation: '자녀',
  },
  {
    id: 'grd_res_jung',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_jung',
    name: '정보호자',
    phone: '010-1111-2305',
    relation: '자녀',
  },
];

export const nokyangCameras: readonly CameraSeed[] = [
  {
    id: 'cam_sp_202',
    facilityId: NOKYANG_FACILITY_ID,
    spaceId: 'sp_202',
    label: 'CAM-2F-202',
  },
  {
    id: 'cam_sp_203',
    facilityId: NOKYANG_FACILITY_ID,
    spaceId: 'sp_203',
    label: 'CAM-2F-203',
  },
  {
    id: 'cam_sp_301',
    facilityId: NOKYANG_FACILITY_ID,
    spaceId: 'sp_301',
    label: 'CAM-3F-301',
  },
  {
    id: 'cam_sp_305',
    facilityId: NOKYANG_FACILITY_ID,
    spaceId: 'sp_305',
    label: 'CAM-3F-305',
  },
  {
    id: 'cam_sp_401',
    facilityId: NOKYANG_FACILITY_ID,
    spaceId: 'sp_401',
    label: 'CAM-4F-401',
  },
];

export const nokyangStatuses: readonly ResidentStatusSeed[] = [
  {
    id: 'status_res_kim',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_kim',
    state: ResidentState.WARNING,
    cameraOnline: true,
    sourceId: 'cam_sp_202',
  },
  {
    id: 'status_res_lee',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_lee',
    state: ResidentState.WARNING,
    cameraOnline: true,
    sourceId: 'cam_sp_203',
  },
  {
    id: 'status_res_park',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_park',
    state: ResidentState.NORMAL,
    cameraOnline: true,
    sourceId: 'cam_sp_401',
  },
  {
    id: 'status_res_choi',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_choi',
    state: ResidentState.NORMAL,
    cameraOnline: true,
    sourceId: 'cam_sp_301',
  },
  {
    id: 'status_res_jung',
    facilityId: NOKYANG_FACILITY_ID,
    residentId: 'res_jung',
    state: ResidentState.NORMAL,
    cameraOnline: true,
    sourceId: 'cam_sp_305',
  },
];

export function verifyNokyangFixture(): void {
  verifyUniqueIds('floors', nokyangFloors);
  verifyUniqueIds('spaces', nokyangSpaces);
  verifyUniqueIds('zones', nokyangZones);
  verifyUniqueIds('residents', nokyangResidents);
  verifyUniqueIds('assignments', nokyangAssignments);
  verifyUniqueIds('guardians', nokyangGuardians);
  verifyUniqueIds('cameras', nokyangCameras);
  verifyUniqueIds('statuses', nokyangStatuses);
}
