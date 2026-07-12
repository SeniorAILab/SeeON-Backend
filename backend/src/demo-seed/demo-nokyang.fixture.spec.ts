import {
  NOKYANG_ADMIN_EMAIL,
  nokyangCameras,
  nokyangFacility,
  nokyangFloors,
  nokyangSpaces,
  verifyUniqueIds,
} from '../../prisma/demo-nokyang.fixture';

describe('nokyang demo fixture', () => {
  it('defines the 녹양역점 facility identity and graph shape', () => {
    expect(nokyangFacility).toMatchObject({
      name: '행복한요양원 녹양역점',
      businessRegistrationNumber: '123-45-67890',
    });
    // 시설 id는 DB가 발급한다 — fixture는 id를 가지지 않는다.
    expect('id' in nokyangFacility).toBe(false);
    expect(nokyangFloors.every((floor) => !('facilityId' in floor))).toBe(true);
    expect(nokyangSpaces.every((space) => !('facilityId' in space))).toBe(true);
    expect(nokyangCameras.every((camera) => !('facilityId' in camera))).toBe(
      true,
    );
    expect(NOKYANG_ADMIN_EMAIL).toBe('nokyang-admin@example.com');
    expect(nokyangFloors.map((floor) => floor.id)).toEqual([
      'fl_b1',
      'fl_1f',
      'fl_2f',
      'fl_3f',
      'fl_4f',
    ]);
    expect(nokyangSpaces).toHaveLength(54);
    expect(nokyangCameras).toHaveLength(7);
  });

  it('keeps every fixture id unique within each table-shaped collection', () => {
    expect(() => verifyUniqueIds('floors', nokyangFloors)).not.toThrow();
    expect(() => verifyUniqueIds('spaces', nokyangSpaces)).not.toThrow();
    expect(() => verifyUniqueIds('cameras', nokyangCameras)).not.toThrow();

    expect(() =>
      verifyUniqueIds('duplicate sample', [{ id: 'dup' }, { id: 'dup' }]),
    ).toThrow('Duplicate duplicate sample fixture id: dup');
  });
});
