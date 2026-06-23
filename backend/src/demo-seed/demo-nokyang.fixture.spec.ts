import {
  NOKYANG_FACILITY_ID,
  nokyangAssignments,
  nokyangCameras,
  nokyangFacility,
  nokyangFloors,
  nokyangGuardians,
  nokyangResidents,
  nokyangSpaces,
  nokyangStatuses,
  nokyangZones,
  verifyUniqueIds,
} from '../../prisma/demo-nokyang.fixture';

describe('nokyang demo fixture', () => {
  it('defines the 녹양역점 facility identity and graph shape', () => {
    expect(nokyangFacility).toMatchObject({
      id: NOKYANG_FACILITY_ID,
      code: 'happy-nokyang',
      name: '행복한요양원 녹양역점',
    });
    expect(nokyangFloors.map((floor) => floor.id)).toEqual([
      'fl_b1',
      'fl_1f',
      'fl_2f',
      'fl_3f',
      'fl_4f',
    ]);
    expect(nokyangSpaces).toHaveLength(54);
    expect(nokyangResidents).toHaveLength(5);
    expect(nokyangAssignments).toHaveLength(5);
    expect(nokyangGuardians).toHaveLength(5);
    expect(nokyangCameras).toHaveLength(5);
    expect(nokyangStatuses).toHaveLength(5);
  });

  it('creates 침대A and 침대B zones only for room spaces', () => {
    const roomSpaces = nokyangSpaces.filter((space) => space.type === 'ROOM');

    expect(roomSpaces).toHaveLength(30);
    expect(nokyangZones).toHaveLength(roomSpaces.length * 2);
    for (const room of roomSpaces) {
      expect(nokyangZones).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: `zone_${room.id}_a`,
            name: '침대A',
            spaceId: room.id,
          }),
          expect.objectContaining({
            id: `zone_${room.id}_b`,
            name: '침대B',
            spaceId: room.id,
          }),
        ]),
      );
    }
  });

  it('keeps every fixture id unique within each table-shaped collection', () => {
    expect(() => verifyUniqueIds('floors', nokyangFloors)).not.toThrow();
    expect(() => verifyUniqueIds('spaces', nokyangSpaces)).not.toThrow();
    expect(() => verifyUniqueIds('zones', nokyangZones)).not.toThrow();
    expect(() => verifyUniqueIds('residents', nokyangResidents)).not.toThrow();
    expect(() =>
      verifyUniqueIds('assignments', nokyangAssignments),
    ).not.toThrow();
    expect(() => verifyUniqueIds('guardians', nokyangGuardians)).not.toThrow();
    expect(() => verifyUniqueIds('cameras', nokyangCameras)).not.toThrow();
    expect(() => verifyUniqueIds('statuses', nokyangStatuses)).not.toThrow();

    expect(() =>
      verifyUniqueIds('duplicate sample', [{ id: 'dup' }, { id: 'dup' }]),
    ).toThrow('Duplicate duplicate sample fixture id: dup');
  });
});
