import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * 이 저장소는 PUBLIC이다. 그런데 운영 문서를 쓰다 보면 실제로 접속에 성공한
 * 값(서버 주소, 키 파일명, 홈 절대경로)을 그대로 붙여넣기 쉽다. 실제로 그런
 * 일이 있었고, 사람이 grep으로 알아채기 전까지 여러 커밋 동안 남아 있었다.
 *
 * 그래서 값 목록이 아니라 **형태**로 막는다. 값 목록으로 막으면 (1) 목록에
 * 없는 새 서버가 생기면 그대로 통과하고 (2) 무엇보다 이 파일 자체가 비밀값을
 * 담은 공개 파일이 된다. 형태로 막으면 둘 다 피한다.
 *
 * 여기서 막지 않는 것도 분명히 해 둔다. 시설명과 호실 번호는 이 저장소가
 * `prisma/demo-nokyang.fixture.ts`로 이미 갖고 있는 데모 시드 설계다. 그것을
 * 이 테스트로 금지하면 기존 시드와 다수 테스트가 깨진다. 바꿀지 말지는
 * 저장소 소유자의 결정이지 이 가드가 일방적으로 정할 문제가 아니다.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

const SKIP_BINARY =
  /\.(png|jpe?g|gif|ico|webp|svg|woff2?|ttf|eot|pdf|mp4|mov|zip|gz)$/i;

/** 문서 예시용으로 IANA가 예약한 대역. 여기 쓰라고 있는 것이므로 허용한다. */
const DOC_SAFE_IPV4 =
  /^(?:192\.0\.2\.|198\.51\.100\.|203\.0\.113\.|233\.252\.0\.)/;

/** 사설/루프백/링크로컬/멀티캐스트. 남의 인프라를 가리키지 않는다. */
const NON_ROUTABLE_IPV4 =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * 100.64.0.0/10은 CGNAT이고 tailscale이 이 대역을 쓴다. 사설 대역처럼
 * 보이지만 그 주소는 특정 tailnet의 실제 노드를 가리키므로 공개하지 않는다.
 * 실제로 이 대역 주소가 문서에 들어간 적이 있어 별도로 잡는다.
 */
const CGNAT_IPV4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

const IPV4 = /(?<![\w.-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\w.-])/g;

// The legacy product origin is an intentionally public browser contract during
// cutover. Keep its exception exact and limited to the configuration and tests
// that enforce that contract; all other routable addresses remain forbidden.
const LEGACY_PRODUCT_IPV4 = '49.247.204.81';
const LEGACY_PRODUCT_IPV4_FILES = new Set([
  '.env.host.prod.example',
  'backend/src/config/env-validation.spec.ts',
  'backend/src/config/frontend-origins.spec.ts',
  'backend/test/cors.spec.ts',
  'docs/runbooks/product-ready-cutover.md',
]);

/**
 * `ssh -i <키>` / `IdentityFile <키>` — 어느 키 파일을 쓰는지도 정찰 정보다.
 *
 * `-i` 앞 토큰에 `\s`를 쓰면 줄바꿈을 넘어 매칭한다. 실제로 `` `ssh iwinv` ``
 * 가 적힌 줄과 한참 아래 다른 줄의 `-i`가 이어져 잡혔다.
 * 그래서 줄바꿈을 뺀 `[^\S\n]`로 같은 줄 안에서만 본다.
 *
 * 이 가드는 `git ls-files` 목록을 **디스크에서** 읽으므로 커밋하지 않은
 * 수정도 잡는다(확인함). 위 오탐이 CI에서야 드러난 것은 스캔 범위 탓이
 * 아니라 문서를 고친 뒤 이 테스트를 돌리지 않았기 때문이다.
 * **문서만 고쳤어도 이 스펙은 돌려야 한다.**
 */
const SSH_KEY_REFERENCE =
  /(?:IdentityFile[^\S\n]+|ssh[^\S\n]+(?:[^\s-][^\s]*[^\S\n]+)*?-i[^\S\n]+)([^\s]+)/g;

/** 개발자 계정명이 드러나는 홈 절대경로. 이식성 문제이기도 하다. */
const HOME_ABSOLUTE_PATH =
  /\/(?:Users|home)\/(?!user\/|runner\/|node\/)[A-Za-z0-9._-]+\//g;

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((entry) => entry.length > 0);
}

function readTextFile(relative: string): string | null {
  if (SKIP_BINARY.test(relative)) return null;
  try {
    const raw = readFileSync(join(REPO_ROOT, relative));
    // NUL이 있으면 바이너리로 보고 건너뛴다.
    if (raw.includes(0)) return null;
    return raw.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * 버전 문자열(`4.11.0.86`)과 IPv4는 형태가 같다. 옥텟 범위만 봐서는 못 가른다.
 * 실제로 opencv 버전이 IPv4로 잡혔다. 그래서 "주소로 쓰이는 자리"인지를 본다.
 */
function looksLikeVersionString(line: string, match: string): boolean {
  const index = line.indexOf(match);
  const before = line.slice(Math.max(0, index - 24), index);
  const after = line.slice(index + match.length, index + match.length + 8);
  if (/(?:==|>=|<=|~=|\^|@|version|v)\s*$/i.test(before)) return true;
  // `opencv-python-headless==4.11.0.86` 처럼 패키지 명세 줄 전체가 버전인 경우
  if (/^[A-Za-z0-9._-]+(?:\[[^\]]*\])?(?:==|>=|<=|~=)/.test(line.trim()))
    return true;
  // 뒤에 포트나 경로가 붙으면 주소로 본다
  if (/^[:/]/.test(after)) return false;
  return false;
}

function offendingIpv4(text: string): string[] {
  const found: string[] = [];
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(IPV4)) {
      const [full, ...octets] = match;
      if (octets.some((octet) => Number(octet) > 255)) continue;
      if (NON_ROUTABLE_IPV4.test(full)) continue;
      if (DOC_SAFE_IPV4.test(full)) continue;
      if (!CGNAT_IPV4.test(full) && looksLikeVersionString(line, full))
        continue;
      found.push(full);
    }
  }
  return found;
}

function collect(pattern: RegExp, text: string): string[] {
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

describe('공개 저장소 프라이버시 가드', () => {
  const files = trackedFiles();

  it('추적 중인 파일을 실제로 읽는다', () => {
    // 가드가 0개 파일을 훑고 통과하는 사고를 막는다.
    expect(files.length).toBeGreaterThan(100);
  });

  it('라우팅 가능한 IPv4 주소가 추적 파일에 없다', () => {
    const violations: string[] = [];
    for (const relative of files) {
      const text = readTextFile(relative);
      if (text === null) continue;
      // 이 가드 파일 자신은 패턴 문자열을 담으므로 제외한다.
      if (relative.endsWith('backend/test/public-repo-privacy.spec.ts'))
        continue;
      for (const hit of offendingIpv4(text)) {
        if (
          hit === LEGACY_PRODUCT_IPV4 &&
          LEGACY_PRODUCT_IPV4_FILES.has(relative)
        ) {
          continue;
        }
        violations.push(`${relative}: ${hit}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('SSH 키 파일 참조가 추적 파일에 없다', () => {
    const violations: string[] = [];
    for (const relative of files) {
      const text = readTextFile(relative);
      if (text === null) continue;
      if (relative.endsWith('backend/test/public-repo-privacy.spec.ts'))
        continue;
      for (const hit of collect(SSH_KEY_REFERENCE, text)) {
        violations.push(`${relative}: ${hit.trim()}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('개발자 홈 절대경로가 추적 파일에 없다', () => {
    const violations: string[] = [];
    for (const relative of files) {
      const text = readTextFile(relative);
      if (text === null) continue;
      if (relative.endsWith('backend/test/public-repo-privacy.spec.ts'))
        continue;
      for (const hit of collect(HOME_ABSOLUTE_PATH, text)) {
        violations.push(`${relative}: ${hit}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('프라이버시 가드 판정 로직', () => {
  // 가드가 무엇을 잡고 무엇을 놓아주는지 고정한다. 이게 없으면 나중에
  // 패턴을 느슨하게 바꿔도 위의 스캔이 여전히 통과해 버린다.

  it.each([
    ['공인 주소', '49.247.204.81'],
    ['공인 주소 + 포트', 'http://49.247.204.81:8080/health'],
    ['tailscale CGNAT 노드', '<REDACTED_CGNAT_ADDRESS>'],
    ['CGNAT 하한', '100.64.0.1'],
    ['CGNAT 상한', '100.127.255.254'],
    // 100/8에서 CGNAT(100.64.0.0/10)를 뺀 나머지는 공인 대역이다.
    // 100.으로 시작한다고 사설이 아니다.
    ['CGNAT 바로 아래는 공인', '100.63.255.255'],
    ['CGNAT 바로 위도 공인', '100.128.0.1'],
  ])('%s는 위반으로 잡는다', (_label, sample) => {
    expect(offendingIpv4(sample)).not.toEqual([]);
  });

  it.each([
    ['사설 10/8', 'DB_HOST=10.0.0.5'],
    ['사설 192.168', '192.168.0.1'],
    ['사설 172.16', '172.16.30.9'],
    ['루프백', 'postgres://localhost 127.0.0.1:55433'],
    ['링크로컬', '169.254.169.254'],
    ['문서용 예시 대역', '203.0.113.10'],
    ['opencv 버전 문자열', 'opencv-python-headless==4.11.0.86'],
    ['옥텟 범위 초과', '999.1.2.3'],
  ])('%s는 통과시킨다', (_label, sample) => {
    expect(offendingIpv4(sample)).toEqual([]);
  });

  it('ssh 키 참조를 형태로 잡는다', () => {
    expect(
      collect(SSH_KEY_REFERENCE, 'ssh -i ~/.ssh/some-deploy-key root@host'),
    ).not.toEqual([]);
    expect(
      collect(SSH_KEY_REFERENCE, '  IdentityFile ~/.ssh/id_ed25519'),
    ).not.toEqual([]);
    // 별칭만 쓰는 형태는 권장 방식이므로 잡지 않는다.
    expect(collect(SSH_KEY_REFERENCE, 'ssh iwinv "docker ps"')).toEqual([]);
  });

  it('줄바꿈을 넘어 `-i`와 이어 붙이지 않는다', () => {
    // 실제로 CI에서 이 형태로 오탐이 났다 — `ssh iwinv`가 적힌 줄과
    // 한참 아래 다른 줄의 `-i` 옵션이 하나로 매칭됐다.
    const doc = [
      '|0|`gh auth status` · `ssh iwinv`|',
      '',
      '어떤 문단이 사이에 들어간다.',
      '',
      'docker exec -i -e PGPASSWORD="$PW" db psql',
    ].join('\n');
    expect(collect(SSH_KEY_REFERENCE, doc)).toEqual([]);
  });

  it('홈 절대경로를 잡되 컨테이너 표준 경로는 놓아준다', () => {
    expect(
      collect(HOME_ABSOLUTE_PATH, 'cd /Users/someone/Projects/app'),
    ).not.toEqual([]);
    expect(
      collect(HOME_ABSOLUTE_PATH, '/home/seniorsailab/state/clip-store'),
    ).not.toEqual([]);
    // Docker 이미지가 관례로 쓰는 경로는 개발자를 식별하지 않는다.
    expect(collect(HOME_ABSOLUTE_PATH, 'WORKDIR /home/user/app')).toEqual([]);
    expect(collect(HOME_ABSOLUTE_PATH, '/home/runner/work/repo')).toEqual([]);
  });
});
