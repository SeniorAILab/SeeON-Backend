import {
  NOKYANG_ADMIN_EMAIL,
  NOKYANG_FACILITY_ID,
  nokyangCameras,
  nokyangFacility,
  nokyangFloors,
  nokyangSpaces,
  verifyUniqueIds,
} from '../../prisma/demo-nokyang.fixture';

describe('nokyang demo fixture', () => {
  it('defines the 녹양역점 facility identity and graph shape', () => {
    expect(nokyangFacility).toMatchObject({
      id: NOKYANG_FACILITY_ID,
      code: 'happy-nokyang',
      name: '행복한요양원 녹양역점',
    });
    expect(NOKYANG_ADMIN_EMAIL).toBe('nokyang-admin@example.com');
    expect(nokyangFloors.map((floor) => floor.id)).toEqual([
      'fl_b1',
      'fl_1f',
      'fl_2f',
      'fl_3f',
      'fl_4f',
    ]);
    expect(nokyangSpaces).toHaveLength(54);
    expect(nokyangCameras).toHaveLength(5);
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
