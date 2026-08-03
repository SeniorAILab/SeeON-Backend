import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * I13: 데모 시드가 프로덕션에서 실수로 돌지 않도록 막는다.
 *
 * 정기 배포 경로는 이 스크립트를 부르지 않는다 — `iwinv-deploy.sh:558`이
 * 부르는 `bootstrap_super_admin()`은 `seed-super-admin.js`만 실행한다. 다만
 * `pnpm db:seed:prod`로 수동 실행하면 녹양 데모 시설·층·방·카메라가 되살아나고
 * 카메라가 다시 online으로 뒤집힌다.
 */
describe('demo seed production guard', () => {
  const source = readFileSync(
    join(__dirname, '..', 'prisma', 'seed.ts'),
    'utf8',
  );

  it('프로덕션에서는 기본적으로 실행을 거부한다', () => {
    expect(source).toContain("process.env.NODE_ENV === 'production'");
    expect(source).toContain('Refusing to run the demo seed in production');
  });

  it('명시적 opt-in 환경변수가 있어야만 통과한다', () => {
    expect(source).toContain("process.env.ALLOW_DEMO_SEED !== '1'");
  });

  it('가드가 PrismaClient 생성보다 먼저 온다', () => {
    const guardIndex = source.indexOf('Refusing to run the demo seed');
    const clientIndex = source.indexOf('new PrismaClient(');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(clientIndex).toBeGreaterThan(-1);
    // DB에 붙기 전에 던져야 커넥션도 열리지 않는다.
    expect(guardIndex).toBeLessThan(clientIndex);
  });

  it('슈퍼어드민 부트스트랩 시드에는 이 가드를 걸지 않는다', () => {
    // 배포 경로가 실제로 부르는 것은 이쪽이므로 막으면 배포가 깨진다.
    const superAdmin = readFileSync(
      join(__dirname, '..', 'prisma', 'seed-super-admin.ts'),
      'utf8',
    );
    expect(superAdmin).not.toContain('Refusing to run the demo seed');
  });
});
