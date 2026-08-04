# 단일 요양원 파일럿 — 아침 실행 런북

**모든 단계는 사람이 직접 실행한다.** 각 단계에 "다음으로 넘어가도 되는 조건"을
적었다. 조건이 안 맞으면 멈춘다.

명령은 저장소의 실제 스크립트에서 확인했다:
`package.json:33`(`release:prod`), `scripts/deploy/iwinv-deploy.sh:22`(usage),
`iwinv-deploy.sh:342`(`verify_services` = 정확 SHA + DB health).

## 시작하기 전에 손으로 준비할 것 3가지

아래는 저장소에 없거나 사람만 정할 수 있는 값이다. **0단계로 들어가기 전에
미리 챙긴다.** 안 그러면 병합·릴리스를 되돌릴 수 없는 지점까지 지나간 뒤
3.5단계에서 막힌다.

**1. 영상 파일 — 이미 있다. 복사하지 말고 경로로 참조한다.**

`eldercare-dataset-ops`의 핀된 릴리스 클립을 쓴다
(`eldercare-fall-ml-v2/docs/runbooks/local-e2e-rtsp-source.md`에 문서화됨):

```text
../eldercare-dataset-ops/ml/data/releases/v1/clips/<핀된 클립>
```

실재 확인함(132MB, HEVC 2520x970, 31.3초). 같은 디렉터리에 다른 클립도 있다.

**쓰기 전에 해시를 확인한다.** 위 런북이 핀을 명시하고 다르면 중단하라고
한다. 야간에 대조해 일치를 확인했다:

```bash
CLIP="../eldercare-dataset-ops/ml/data/releases/v1/clips/<핀된 클립>"
shasum -a 256 "$CLIP"
# 기대: local-e2e-rtsp-source.md에 적힌 핀 값과 일치해야 한다
```

> **저장소 안으로 복사하지 않는다.** 위 런북이 명시한다 —
> "Do not add MediaMTX, an FFmpeg publisher, a video file, or any other
> RTSP serving surface to this repository." 사설 의료 영상이고
> 워크스페이스 `AGENTS.md`도 private media 커밋을 금지한다.
> `rtsp-generator`는 저장소 밖 경로를 인자로 받으므로 그대로 넘기면 된다.

**2. 엣지 대시보드 계정** — `.env.edge.prod`의
`API_DASHBOARD_USERNAME` / `API_DASHBOARD_PASSWORD`.
비우면 컨테이너가 아예 뜨지 않는다. 그게 안전장치다 — 비워두면
`admin/admin`으로 뜨는 게 아니라 기동 자체가 막힌다.

**3. 백엔드 주소** — `.env.edge.prod`의 `API_BACKEND_BASE_URL`(권장) 또는
`API_BACKEND_EVENTS_URL`+`API_BACKEND_CONFIG_URL`.
**둘 다 비우면 가짜 도메인이 기본값으로 들어가고 heartbeat가 안 나간다.**
`.env.edge.prod.example`에는 `BASE_URL`이 없으니 직접 추가해야 한다.

---

## 0. 시작 전 확인

```bash
git status --short          # compose.yaml 외 dirty 없어야 함
gh pr checks 657 --repo SeniorAILab/eldercare-fall-ai
gh pr checks 658 --repo SeniorAILab/eldercare-fall-ai
gh pr checks 142 --repo SeniorAILab/eldercare-fall-ml-v2

# 오늘 쓰는 도구가 다 있는지. 야간에 이 맥에서 확인한 값을 주석에 남긴다.
for t in uv gh docker pnpm node; do printf '%-8s ' "$t"; command -v "$t" >/dev/null && "$t" --version | head -1 || echo 없음; done
docker info >/dev/null && echo "docker 데몬 실행 중"
# 확인된 버전: uv 0.10.4 / gh 2.97.0 / docker 29.6.1 / pnpm 11.0.0 / node v24.19.0
# psql은 로컬에 없어도 된다 — 6단계는 docker exec로 DB 컨테이너 안에서 실행한다.

# 프로덕션 접속 경로 — 3~6단계에서 쓴다. 여기서 미리 확인한다.
ssh -o BatchMode=yes iwinv 'echo ok && hostname'
# 기대: ok + 프로덕션 호스트명 (~/.ssh/config의 Host iwinv가 가리키는 서버)
```

**진행 조건:** 세 PR 모두 전 항목 pass, `ssh iwinv` 응답 확인.

> 접속 정보는 `~/.ssh/config`의 `Host iwinv`(공인 IP 직결, root)만 쓴다. **tailscale blackwell
> 노드는 접근하지 않는다** — 주소는 `~/.ssh/config`와 `tailscale status`에서 확인한다.

---

## 1. 스크린샷 승인

```
.gjc/_session-019fc81a-.../ultragoal/artifacts/
  monitor-mixed.png      위험 1 + 확인됨 1 + 연결 끊김 5
  monitor-all-live.png   전 카메라 연결, 위험/확인필요/주의/안정 혼재
  monitor-panel.png      위험한 방을 눌렀을 때의 조작면 (I4 확인/해결 분리)
```

**볼 것**

- 상단 헤더가 함께 찍혀 있는가 — 시설명, 안전 현황 요약, 시계, 층 탭,
  그리고 **알림 벨의 숫자 배지**. 벨 배지는 "상단 가로 배너를 만들지 않고
  벨 숫자로만 알린다"는 요구의 산출물이므로, 이게 안 보이는 스크린샷을
  승인하면 정작 요구한 물건을 승인하지 못한 것이 된다
- 끊긴 방: 회색 해칭 + "연결 끊김" + 카메라-꺼짐 아이콘 (체크 표시가 아님)
- 위험한 방이 끊긴 방들 사이에서 **맨 앞**에 오는가
- "확인됨" 배지가 붙은 방과 안 붙은 방이 구분되는가
- 4m 떨어져서 읽히는가
- **맨 아래 층의 방 이름이 잘리지 않고 다 보이는가**

> **카드 크기를 `xl`로 바꾸지 말 것 (TV 전체 보기 기준).**
>
> 기본값은 `lg`다(`front/src/features/monitor/stores/monitorSettingsStore.ts:14`).
> 1920×1080에서 층 3개·방 7개를 `lg`로 그리면 맨 아래 방까지 이름이 보인다
> (실측: 이름 아래끝 1064px, 카드 테두리만 5px 잘림 — 읽는 데 지장 없음).
>
> 같은 화면을 `xl`로 바꾸면 맨 아래 층 카드가 **61px(카드의 38%) 잘려 방
> 이름이 화면 밖으로 나간다.** 그 방에서 낙상이 나면 붉은 카드는 보이는데
> 어느 방인지 모른다. TV에는 스크롤할 사람이 없다.

**스크린샷은 실제 TV 화면(1920×1080)이고 층 구성도 프로덕션과 같다**

카메라가 있는 층만 나온다(2층 4개 / 3층 2개 / 4층 1개). 내일 실제로 뜰
화면과 같은 구조다.

> 야간에 두 번 고쳤다. 처음에는 보드 요소만 잘라 1800×656으로 찍고 있었고,
> 그다음에는 방 7개를 전부 2층 하나에 몰아넣고 있었다. 둘 다 승인한 화면과
> 현장 화면이 달라지는 문제라 고쳤다.

**이 스크린샷이 덮지 않는 것**

승인용 이미지는 현황판 2종과 조작면 1종이다. 이번 릴리스에 포함되지만
**시각 증거가 없는 화면**이 있다 — 승인 범위를 정확히 알고 넘어간다.

| 화면 | 상태 |
|---|---|
| 현황판(위험/확인됨/연결끊김) | 스크린샷 있음 |
| TV 조작면 확인/해결 분리 | **스크린샷 있음**(`monitor-panel.png`) + 테스트 30건 |
| 관리자 이벤트 목록·상세 | 테스트만(`AdminEventDetailPage` 6건 외) |
| 슈퍼관리자 전역 화면 | 테스트만(`SuperAdminDashboardPage` 12건) |
| 엣지 대시보드 연결/카메라 | 테스트만(`ml-v2` front 514건에 포함) |

관리자·엣지 화면은 4단계 smoke에서 실물로 보게 된다. **현황판만 미리
승인하고 나머지는 smoke에서 눈으로 확인한 뒤 넘어간다.**

**진행 조건:** 이 화면을 요양보호사에게 보여줘도 되겠다는 판단.

---

## 2. PR 병합 — 순서 고정

> **squash를 쓰면 안 된다.** #658 브랜치는 #657의 커밋 7건을 그대로 포함한다.
> #657을 squash하면 `main`에는 그 7건과 다른 새 커밋 하나가 생기고, 이어서
> #658을 squash할 때 같은 변경이 두 갈래로 들어와 충돌한다.
>
> 야간에 실제로 시뮬레이션했다(`git worktree` + `merge --squash`):
> **squash → 5개 파일 충돌**
> (`RoomStatusTreemap.tsx`, `RoomStatusTreemap.test.tsx`, `alertEndpoints.ts`,
> `cameras.test.ts`, `monitorStore.test.ts`).
> **merge commit → 충돌 0건.**

```bash
gh pr merge 657 --repo SeniorAILab/eldercare-fall-ai --merge
# main CI 통과 확인 후
gh pr merge 658 --repo SeniorAILab/eldercare-fall-ai --merge
# ml-v2는 독립이라 방식 무관하지만 통일한다
gh pr merge 142 --repo SeniorAILab/eldercare-fall-ml-v2 --merge
```

**순서를 지켜야 하는 이유:** #658은 `SpaceStatus.connection` 타입을 쓴다.
#657 없이 병합하면 빌드가 깨진다.

**진행 조건:** `main` CI green.

> 저장소 정책이 squash를 강제한다면, #657을 먼저 squash 병합한 뒤
> `fix/pilot-admin-surfaces`를 `main`에 rebase해서 중복 커밋을 걷어낸 다음
> #658을 올린다. 그 경우 rebase 후 CI를 다시 통과시켜야 한다.

---

## 3. 릴리스 발행

**먼저 서버 여유를 본다.** 완전히 안전한 검사다 — 메모리와 디스크만 읽고
즉시 종료하며 아무것도 바꾸지 않는다
(`iwinv-deploy.sh:30-37`, `--preflight-only`는 `preflight` 실행 후 `exit 0`).

```bash
ssh iwinv '/opt/eldercare-fall-ai/repo/scripts/deploy/iwinv-deploy.sh --preflight-only'
# 필요: 메모리+스왑 1024MiB 이상, 디스크 2048MiB 이상
```

여기서 부족하다고 나오면 **발행하지 않는다.** 배포 도중 같은 검사로 멈추면
컨테이너만 교체된 채 릴리스 포인터가 갱신되지 않는 상태가 된다(5단계 참조).

여유가 확인된 뒤에 발행한다.

```bash
# 현재 최신 릴리스는 v0.5.7이므로 다음은 v0.5.8이다.
# 태그는 vMAJOR.MINOR.PATCH만 받는다 — v0.5.8-rc1 같은 형식은 거부된다
# (create-production-release.mjs:70).
pnpm release:prod -- v0.5.8 --dry-run   # 먼저 이걸로 명령을 확인
pnpm release:prod -- v0.5.8             # 확인 후 실제 발행
```

> **`--dry-run`은 실행할 명령을 찍고 끝난다.** 야간에 실제로 돌려 확인했다:
> `gh 'release' 'create' 'v0.5.8' '--target' 'main' '--title' 'v0.5.8' '--generate-notes'`
> (exit 0, 아무것도 만들지 않음).
>
> **두 번째 줄이 곧 배포다.** `gh release create`는 `--draft` 없이 즉시
> 게시하고, 게시되는 순간 `release: published` 워크플로가 돈다. 중간에
> 한 번 더 묻는 단계는 없다.
>
> `--target main`이므로 **그 시점의 `main` HEAD**로 릴리스가 만들어진다.
> 2단계 병합이 끝나 있어야 하는 이유다.

> **태그 push로는 배포가 안 나간다.** `release: published` 트리거만 동작한다.
>
> **버전을 올려야 실제로 나간다.** `ADR-002-release-based-cd`에 따르면
> 같은 버전이나 **더 낮은 버전을 다시 발행하면 성공한 no-op으로 수렴**한다 —
> 빌드도 배포도 하지 않는다. 실패로 보이지 않으므로 "발행했는데 왜 안
> 바뀌지"가 된다. `v0.5.7`이 최신이니 반드시 `v0.5.8` 이상을 쓴다.
>
> **병합이 먼저다.** Jenkins가 해석한 태그 커밋이 `origin/main`에 포함돼
> 있어야 한다(같은 ADR). 2단계 병합을 마치기 전에 발행하면 그 조건을
> 못 채운다.

배포 경로: Actions → Jenkins webhook(30초, 재시도 없음) → SHA resolve →
`iwinv-deploy.sh --sha <sha>`

**진행 조건:** Jenkins 잡이 실제로 시작됐는지 확인. 30초 안에 안 잡히면
webhook을 놓친 것이므로 수동 트리거.

---

## 3.5 엣지 기동 (맥북)

> **맥북 엣지와 현장 엣지는 설정이 다르다. 섞지 않는다.**
>
> | | 맥북 (오늘) | 현장 GPU 호스트 |
> |---|---|---|
> | env 파일 | `.env.edge.prod` | `.env.edge.deploy` |
> | compose | `compose.edge.yaml` | `+ compose.edge.local.yaml`(저장소에 없음) |
> | 프로필 | `mps` | `cuda` |
>
> 현장 호스트 절차는
> `eldercare-fall-ml-v2/docs/runbooks/driver-cuda-alignment.md`에 따로 있다.
> 그 문서가 경고하듯 **`.env.edge.deploy`에는 `ML_WORKER_PROFILE`이 없어
> compose 명령이 그대로는 실패하고, compose로 재생성하면 현재 컨테이너와
> 다른 `restart` 정책이 붙는다**(알려진 배포 재현성 결함). 오늘은 맥북만
> 다루므로 그 경로를 건드리지 않는다.
>
> GPU가 도착해 현장으로 옮길 때 그 런북을 먼저 읽는다.

현장 엣지는 GPU 고장으로 오프라인이고, GPU는 오늘 도착 예정이다. 오늘은
**맥북에 엣지를 새로 띄운다.** 아래 단계 없이 4번으로 가면 볼 것이 없다.

`eldercare-fall-ml-v2`에서 (`compose.edge.yaml`, `.env.edge.prod.example`):

```bash
cd "eldercare-fall-ml-v2"
cp .env.edge.prod.example .env.edge.prod   # 없으면
```

**필수 env 8개** — 하나라도 비면 컨테이너가 아예 뜨지 않는다
(`compose.edge.yaml`에서 `:?`로 강제):

```
ML_API_IMAGE  ML_WORKER_IMAGE  ML_WORKER_PROFILE
API_EDGE_RELAY_TOKEN  API_DASHBOARD_USERNAME  API_DASHBOARD_PASSWORD
API_FACILITY_ID  CLIP_STORE_HOST_DIR
```

**맥북에서 반드시 바꿀 것:**

```bash
# .env.edge.prod.example:33 기본값이 cuda다. 맥북은 mps.
ML_WORKER_PROFILE=mps
API_FACILITY_ID=<FACILITY_ID>
```

```bash
docker compose --env-file .env.edge.prod -f compose.edge.yaml up -d
docker compose -f compose.edge.yaml ps
```

**진행 조건:** ml-api와 worker 컨테이너가 모두 Up.

> 컨테이너가 안 뜨면 십중팔구 필수 env 누락이다 — `docker compose ... config`가
> 어떤 변수가 비었는지 이름으로 알려준다.

### 3.5-b 클라우드 연결 설정

컨테이너가 떠도 **클라우드 연결은 별도 설정**이다. 이게 없으면 heartbeat가
안 나가고 4번에서 볼 것이 없다.

env로 줄 수 있는 값 (`backend/app/features/connection/store.py:75,153-154`):

```
API_BACKEND_BASE_URL   예: https://<프로덕션 호스트>   ← 이거 하나로 충분
API_FACILITY_ID        <FACILITY_ID>
EDGE_FACILITY_TOKEN    시설 토큰
```

> **`.env.edge.prod.example`에는 `API_BACKEND_BASE_URL`이 없다.** 그 파일은
> `API_BACKEND_EVENTS_URL`과 `API_BACKEND_CONFIG_URL`을 각각 전체 URL로
> 지정하는 옛 방식을 예시로 든다. 둘 중 아무 방식이나 되지만,
> **`BASE_URL`을 안 쓰면 `compose.edge.yaml:25`의 기본값
> `https://api.eldercare-fall-ai.example`(가짜 도메인)이 들어간다.**
>
> 따라서 둘 중 하나를 반드시 한다:
> - `API_BACKEND_BASE_URL`을 실제 호스트로 채운다(권장), 또는
> - `API_BACKEND_EVENTS_URL`/`API_BACKEND_CONFIG_URL`을 전체 URL로 채운다
>
> 어느 쪽이든 3.5-b 진행 조건대로 **연결 설정 화면에서 실제 값을 눈으로
> 확인**한다. 가짜 도메인이 남아 있으면 heartbeat가 나가지 않는다.

> **`/api` 처리는 두 방식이 다르다. 여기서 틀리면 조용히 404가 된다.**
>
> - `API_BACKEND_BASE_URL`을 쓰면 **`/api`를 붙이지 않아도 된다.**
>   `store.py:_normalize_api_base`가 base에 `/api`를 붙여
>   `{base}/api/v1/events`를 만든다. 이미 `/api`로 끝나면 중복해서 붙이지
>   않는다.
> - `API_BACKEND_EVENTS_URL`/`API_BACKEND_CONFIG_URL`을 쓰면 **`/api`를
>   직접 넣어야 한다.** 이 두 변수는 `store.py:145,150`에서 정규화 없이
>   그대로 쓰인다. `.env.edge.prod.example`의 예시가
>   `.../api/v1/events`인 것도 그래서다. 호스트만 바꾸고 `/api/v1/events`는
>   그대로 둔다.
>
> 이 구분을 놓치면 엣지가 `{host}/v1/events/...`로 쏘고 NestJS는 모든
> 라우트를 `/api` 아래 두므로 404가 난다. 엣지는 그걸 조용한 실패로
> 넘겨서 **카메라가 계속 online으로 보인다** — 이번에 고친 결함이 정확히
> 이것이다(`store.py:96-113` 주석).

> **함정 — 저장된 설정이 env를 이긴다.** `store.py:153-154`가
> `saved.get(...) or os.environ.get(...)` 순서다. 예전에 대시보드에서 저장한
> 값이 남아 있으면 env를 바꿔도 반영되지 않는다. **연결 설정 화면에서 실제
> 값을 눈으로 확인하고, 다르면 화면에서 저장한다.**

**진행 조건:** 연결 설정 화면의 시설 ID와 이벤트 URL이 의도한 값이다.

---

## 3.5-c 합성 스트림 + 카메라 등록

**순서가 중요하다.** 카메라 등록의 연결 테스트는 실제로 스트림에 붙어봐야
통과하므로 rtsp-generator를 **먼저** 띄운다. 그리고 4번 smoke는 카메라가
등록돼 있어야 볼 것이 있다.

### 스트림 2개 (`rtsp-generator`, `README.md:39-59`)

> **영상은 dataset-ops의 핀된 클립을 경로로 참조한다**(준비물 1번 참조).
>
> `rtsp-generator`는 MediaMTX와 FFmpeg 퍼블리싱을 Docker로 묶어 돌린다
> (`rtsp-generator/README.md:98`). 즉
> `eldercare-fall-ml-v2/docs/runbooks/local-e2e-rtsp-source.md`가 설명하는
> 수동 3터미널 절차(MediaMTX 직접 실행 + ffmpeg 퍼블리시 + ffprobe 게이트)의
> 자동화 버전이다. **둘 중 하나만 쓴다.** 아래는 CLI 방식이고, 수동으로
> 확인하고 싶으면 그 런북을 따르면 된다.
> README의 `fall-sample.mp4`는 예시 이름일 뿐 저장소에 없다.
> 같은 파일을 두 경로에 써도 오라클은 성립한다 — 판정 기준은 heartbeat
> 도달 여부이지 영상 내용이 아니다.

```bash
cd "rtsp-generator"
uv sync --group dev
# dataset-ops의 핀된 클립을 저장소 밖 경로 그대로 넘긴다 (복사 금지)
CLIP="../eldercare-dataset-ops/ml/data/releases/v1/clips/<핀된 클립>"
uv run rtsp-generator start "$CLIP" --path <카메라A> \
                            "$CLIP" --path <카메라B> \
                            --name nursing-home --detach
uv run rtsp-generator list        # RTSP URL 확인
```

### 엣지에 카메라 2대 등록

엣지 대시보드(3.5-b에서 연 화면)에서 카메라를 추가한다.

- RTSP 주소는 위 `list`가 출력한 URL을 쓴다.
- **"설치된 방"에서 **대상 방 두 곳**을 고른다.** 방을 안 고르면
  클라우드 push 대상에서 제외돼 현황판에 영영 안 나타난다.
- **"방 목록을 아직 받지 못했습니다" 안내가 뜨면 여기서 멈춘다** —
  클라우드 roster가 아직 안 온 것이므로 3.5-b 연결 설정을 다시 본다.
- 저장 전 **연결** 버튼이 성공해야 한다. 주소를 고쳤으면 다시 눌러야 한다
  (통과한 주소와 지금 값이 다르면 저장이 거부된다).

**진행 조건:** 카메라 2대가 각각 대상 방 두 곳에 매핑된 상태로 저장됨.

정리(끝난 뒤):

```bash
uv run rtsp-generator stop --name nursing-home
```

---

## 4. Smoke — **엣지부터**

### 4-1. 엣지 대시보드 (제일 먼저)

**접근 방법** (`eldercare-fall-ml-v2` 확인):

- 엣지 API는 `127.0.0.1:${ML_SERVING_PORT:-8000}`에만 바인딩된다
  (`compose.edge.yaml:18`). **원격에서 바로 열리지 않는다** — 엣지를 돌리는
  맥북에서 직접 열거나 SSH 포트포워딩을 쓴다.
- 대시보드는 그 포트의 `/`에 서빙된다(`backend/app/main.py:67`).
- 로그인이 필요하다. 계정은 `API_DASHBOARD_USERNAME` /
  `API_DASHBOARD_PASSWORD` env로 주입된다(`compose.edge.yaml:31-32`).
  값이 없으면 컨테이너가 아예 뜨지 않는다.

```
http://127.0.0.1:8000/     ← 엣지를 돌리는 기기에서
```

거기서 연결 설정 화면을 연다.

**클라우드 전송** 행이 무엇을 말하는지가 핵심이다. 문구는 소스에서
그대로 옮겼다(`ConnectionSettingsPanel.tsx`의 `heartbeatRelayLabel`):

| 화면 문구 | 뜻 / 다음 행동 |
|---|---|
| `정상 · 마지막 전송 …` | **이것만 정상이다.** 다음 단계로 |
| `꺼짐 — 카메라 상태가 클라우드로 전달되지 않습니다` | relay 비활성. 설정 확인 |
| `실패 (인증) — 시설 ID와 토큰을 확인하세요` | 3.5-b의 `API_FACILITY_ID`/토큰 |
| `실패 (응답 없음) — 서버 주소와 네트워크를 확인하세요` | 백엔드 주소(가짜 도메인?) |
| `실패 (연결 불가) — 서버 주소와 네트워크를 확인하세요` | 같음 |
| `전송 기록 없음` | 아직 한 번도 못 보냈다. 잠시 후 재확인 |
| `정보 없음` | 백엔드가 필드를 안 줬다. ml-api 로그 확인 |

카메라 카드에서도 두 가지를 본다:

| 화면 문구 | 뜻 / 다음 행동 |
|---|---|
| 클라우드 연동 `연동 완료` | 정상. 이 카메라가 현황판에 뜬다 |
| 클라우드 연동 `연동 대기` | 방 미지정. 등록 화면에서 방을 고른다 |
| 연결 이력 = 시각 | 정상. 그 시각에 붙었다 |
| `한 번도 연결된 적 없음 — 주소와 계정을 확인하세요` | RTSP 주소·계정 오류 |
| `연결 기록 없음` | 백엔드가 시각을 안 줌 |
| `시각 불명` | 시각 파싱 실패. ml-api 로그 |

> 마지막 세 줄은 야간에 추가한 것이다. 예전에는 **한 번도 붙은 적 없는
> 카메라와 붙었다가 끊긴 카메라가 화면상 똑같았다** — 기사가 주소를
> 의심해야 할지 네트워크를 의심해야 할지 알 수 없었다.

**여기가 실패면 클라우드 현황판은 볼 것도 없이 전부 회색이다.**
heartbeat URL의 `/api` prefix 수정이 실제로 통하는지는 여기서만 확인된다.

### 4-2. 클라우드

```bash
ssh iwinv 'docker ps --format "{{.Names}}\t{{.Status}}"'
```

- 로그인 → 현황판 진입 (무한 로딩이 아님)
- 카메라 2대 방이 초록, 나머지 회색 해칭
- 알림 하나에 **확인** → 배지 뜨는지 → 메모 → **해결 완료**

**관리자 이벤트 상세를 열면 이 문구가 뜬다 — 정상이다.**

> 근거 영상 저장이 아직 켜져 있지 않습니다 …
> 이 알림의 녹화가 실패한 것이 아니라 기능이 꺼져 있는 상태입니다

I2가 오늘 범위 밖(env 두 개가 꺼짐)이라 나오는 문구다. **버그가 아니다.**

야간에 이 구분을 만들었다. 예전에는 기능이 꺼져 있어도
`이 알림에 연결된 근거 영상이 없습니다`로 떴다 — 원장이 그 알림만 녹화에
실패했다고 오해할 문구였다. 지금은 둘을 다르게 말한다.

| 문구 | 뜻 |
|---|---|
| `근거 영상 저장이 아직 켜져 있지 않습니다` | **기능 off. 오늘 정상** |
| `이 알림에 연결된 근거 영상이 없습니다` | 기능은 켜졌는데 이 건에 클립이 없음 |
| `보관 기간이 만료되어 …` / `보관 정책에 따라 삭제되어 …` | 있었으나 만료·삭제됨 |

**진행 조건:** 위 흐름이 끊김 없이 완료.

---

## 5. 배포 실패 시 (자동 복구 없음)

`verify_services` 실패 시 `activate_manifest`가 실행되지 않아
**`current.json`은 구버전인데 깨진 신버전 컨테이너가 떠 있을 수 있다.**

```bash
# 경로는 iwinv-deploy.sh:5-6 기준 (APP_ROOT=/opt/eldercare-fall-ai, APP_DIR=$APP_ROOT/repo)
ssh iwinv '/opt/eldercare-fall-ai/repo/scripts/deploy/iwinv-deploy.sh --rollback'
# 특정 SHA로: --rollback <sha>
```

롤백 후 **4번 smoke를 처음부터 다시** 실행한다.

> **엣지 워커가 이상할 때는 여기가 아니다.** 위 절차는 클라우드(iwinv)
> 배포용이다. 엣지 워커 이미지를 되돌려야 하면
> `eldercare-fall-ml-v2/docs/runbooks/worker-migration-rollback.md`를 따른다 —
> 소스 revert가 아니라 `ML_WORKER_IMAGE`를 이전 digest로 되돌리고 그 서비스만
> 재시작하는 방식이며, 모델·상태·클립 볼륨은 보존된다.

---

## 6. Space 47행 정리 — 파괴적, 되돌릴 수 없음

**반드시 덤프 먼저.**

경로는 `scripts/deploy/iwinv-deploy.sh:5-11`에서 확인했다 —
`APP_ROOT=/opt/eldercare-fall-ai`, env는 `$APP_ROOT/shared/.env`.
DB 자격증명은 그 env 파일에만 있으므로 **하드코딩하지 말고 읽어서 쓴다.**

```bash
# 1) 덤프 — 자격증명을 env에서 읽어 쓴다(추측 금지)
ssh iwinv 'set -a; . /opt/eldercare-fall-ai/shared/.env; set +a;
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" eldercare-fall-db \
    pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -t spaces -t floors --data-only' \
  > spaces-floors-$(date +%Y%m%d-%H%M).sql

# 덤프가 비어 있지 않은지 확인 — 0바이트면 여기서 멈춘다
wc -l spaces-floors-*.sql
```

이후 SQL은 같은 방식으로 접속한다:

```bash
ssh iwinv 'set -a; . /opt/eldercare-fall-ai/shared/.env; set +a;
  docker exec -it -e PGPASSWORD="$POSTGRES_PASSWORD" eldercare-fall-db \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

```sql
-- 0-a) 테이블명 확인 — spaces/facilities는 마이그레이션 DDL로 확정하지 못했다
\dt
-- 기대: spaces, cameras, events, alerts, facilities
--       다르면 아래 모든 쿼리의 이름을 실제 값으로 맞춘다

-- 0) 시설 id 확인 — 이후 모든 쿼리에 이 값을 넣는다
SELECT id, name FROM facilities;
-- 이 결과의 id를 아래 <FACILITY_ID> 자리에 넣는다

-- 2) 삭제 대상 수 확인 — 47이어야 한다
--    카메라·이벤트·알림이 전무한 방만 해당
--    spaces/cameras/events/alerts는 모두 facility_id를 갖고 FK가
--    (facility_id, space_id) 복합키다. 시설 스코프를 빼면 다른 시설의
--    행까지 대상이 되므로 반드시 넣는다.
SELECT count(*) FROM spaces s
WHERE s.facility_id = '<FACILITY_ID>'
  AND NOT EXISTS (
    SELECT 1 FROM cameras c
    WHERE c.facility_id = s.facility_id AND c.space_id = s.id)
  AND NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.facility_id = s.facility_id AND e.space_id = s.id)
  AND NOT EXISTS (
    SELECT 1 FROM alerts a
    WHERE a.facility_id = s.facility_id AND a.space_id = s.id);

-- 3) 47이 확인된 뒤에만 DELETE.
--    아래는 2)의 WHERE와 글자 그대로 같다. 손으로 옮겨 적지 말고
--    통째로 복사한다 — NOT EXISTS 한 덩어리를 빠뜨리면 카메라나
--    이벤트가 붙은 방까지 지워지고, 그건 되돌릴 수 없다.
--
--    트랜잭션으로 감싼다. DELETE가 몇 행을 지웠는지 보고 47이 아니면
--    COMMIT 대신 ROLLBACK 한다. 이게 마지막 방어선이다.
BEGIN;

DELETE FROM spaces s
WHERE s.facility_id = '<FACILITY_ID>'
  AND NOT EXISTS (
    SELECT 1 FROM cameras c
    WHERE c.facility_id = s.facility_id AND c.space_id = s.id)
  AND NOT EXISTS (
    SELECT 1 FROM events e
    WHERE e.facility_id = s.facility_id AND e.space_id = s.id)
  AND NOT EXISTS (
    SELECT 1 FROM alerts a
    WHERE a.facility_id = s.facility_id AND a.space_id = s.id);
-- psql이 'DELETE 47'을 출력해야 한다.

-- 47이 아니면 여기서 ROLLBACK; 을 치고 멈춘다.
-- 47이면 아래 확인 쿼리를 트랜잭션 안에서 먼저 돌린다.
SELECT count(*) FROM spaces WHERE facility_id = '<FACILITY_ID>';
-- 7이어야 한다. 7이 아니면 ROLLBACK;

COMMIT;

-- 4) COMMIT 뒤 최종 확인 — 2)의 count 쿼리를 다시 돌리면 0이어야 한다.
--    남는 방 7개의 구성: 2층 4개, 3층 2개, 4층 1개 (카메라가 붙은 방만)
--    1층과 5층에는 방이 하나도 안 남는다 — 현황판에서 그 층 그룹이 통째로
--    사라진다. 정상이다(빈 층은 렌더하지 않는다, RoomStatusTreemap:82).
```

**중단 조건:** 2번 결과가 47이 아니면 **멈춘다.** 시드 이후 데이터가 붙었다는
뜻이므로 대상을 다시 산정해야 한다.

`Space`에는 `onDelete: Cascade`가 없어 FK 충돌 없이 지워진다.

---

## 7. 2녹색 / 5회색 오라클

스트림 기동과 카메라 등록은 **3.5-c**에서 이미 했다. 여기서는 판정만 한다.
GPU 도착 전이므로 살아 있는 카메라는 2대다.

> **카메라 id 주의(3.5-c 재확인).** 프로덕션에 이미 있는 `<카메라A>`(첫 번째 대상 방)와
> `<카메라B>`(두 번째 대상 방)에 매핑돼 있어야 한다. 새 id로 등록했다면
> 클라우드에 카메라가 추가돼 7대가 아니라 9대가 되고 기대값이 깨진다.

**어느 화면에서 재는지가 중요하다.** 카메라 7대는 2F·3F·4F에 흩어져 있어
**층별 화면에서는 7개가 다 안 보인다** — `FloorMonitorPage.tsx:78`이
`allView`가 아니면 해당 층만 필터한다.

전체 층 화면에서 잰다 (`router.tsx:83,89`):

```
/facilities/<FACILITY_ID>/dashboard        ← allView, 여기서 잰다
/facilities/<FACILITY_ID>/floor/<floorId>  ← 층별, 여기선 안 됨
```

전체 층 진입이 안 되면 모니터 설정의 `allowAllView`가 꺼진 것이다
(`FloorMonitorPage.tsx:134`가 그때 다른 화면으로 보낸다).

### 7-2-a. DB 쪽 판정 (SQL)

DOM을 보기 전에 데이터가 맞는지부터 본다. 화면이 틀린 것과 데이터가 틀린
것은 고치는 곳이 다르다.

> 계획 §6의 SQL은 `"Camera"` / `SpaceStatusSnapshot` 같은 Prisma 모델명을
> 쓰는데, 실제 테이블은 `cameras`이고 **`SpaceStatusSnapshot`은 존재하지
> 않는다**(상태는 프론트 `alertMerge.ts`가 합성한다). 실제 스키마
> (`backend/prisma/schema.prisma`)에 맞춰 다시 썼다.

**먼저 테이블명을 확인한다.** 아래 SQL은 `schema.prisma`의 `@@map`과
마이그레이션 DDL(`Camera → cameras`, `Alert → alerts`,
`lastSeenAt → last_seen_at`, `AlertStatus = NEW|ACKED|RESOLVED`)에서
확인했지만, `spaces`/`facilities`는 리네임 이력이 없어 DDL로 확정하지
못했다. 한 줄로 실제 이름을 확인하고 시작한다.

```sql
\dt
-- 기대: cameras, spaces, alerts, facilities (다르면 아래 SQL의 이름을 맞춘다)
```

```sql
-- (1) 카메라 총 7대, 방과 1:1
SELECT count(*) AS cameras, count(DISTINCT space_id) AS spaces
FROM cameras WHERE facility_id = '<FACILITY_ID>';
-- 기대: 7 / 7

-- (2) 최근 3분 내 heartbeat = 2대
SELECT count(*) FROM cameras
WHERE facility_id = '<FACILITY_ID>'
  AND last_seen_at >= now() - interval '3 minutes';
-- 기대: 2

-- (3) 어느 카메라가 살아 있는지 — 등록한 두 대와 일치해야 한다
SELECT id, space_id, last_seen_at FROM cameras
WHERE facility_id = '<FACILITY_ID>'
  AND last_seen_at >= now() - interval '3 minutes'
ORDER BY id;
-- 기대: <카메라A> / <카메라B>

-- (4) 그 두 방에 활성 알림이 없어야 "녹색"이 된다
SELECT space_id, count(*) FROM alerts
WHERE facility_id = '<FACILITY_ID>'
  AND space_id IN ('<방A>', '<방B>')
  AND status IN ('NEW', 'ACKED')
GROUP BY space_id;
-- 기대: 0행
```

**(2)가 0이면 heartbeat가 안 오는 것이다** — 4-1의 "클라우드 전송"으로
돌아간다. **(4)에 행이 있으면** 그 방은 정직하게 빨강이므로 알림을 해결한
뒤 다시 잰다.

### 7-2-b. 화면 쪽 판정 (DOM)

**기계 판정(육안 아님)** — 위 dashboard 화면에서 개발자도구 콘솔:

```js
[...document.querySelectorAll('[data-connection]')]
  .reduce((a, n) => (a[n.dataset.connection] = (a[n.dataset.connection] || 0) + 1, a), {})
// 기대: { LIVE: 2, STALE: 5 }
```

타일마다 `data-space-id` / `data-status` / `data-connection`이 붙어 있다.

> **`LIVE=2`만으로는 "2녹색"이 아니다.** `LIVE`인데 `DANGER`면 그 타일은
> 빨강이지 녹색이 아니다. 계획 §6이 semantic 판정을 따로 요구하는 이유다.

이어서 실행한다:

```js
const tiles = [...document.querySelectorAll('[data-connection]')].map((n) => ({
  space: n.dataset.spaceId,
  status: n.dataset.status,
  conn: n.dataset.connection,
  label: n.getAttribute('aria-label'),
}));

// (5) LIVE 2개가 전부 STABLE인가 — 이래야 "녹색"이다
const live = tiles.filter((t) => t.conn === 'LIVE');
console.log('live', live.length, live.every((t) => t.status === 'STABLE'));
// 기대: 2 true

// (6) STALE 5개가 status와 무관하게 "연결 끊김" 라벨을 다는가
const stale = tiles.filter((t) => t.conn === 'STALE');
console.log('stale', stale.length, stale.every((t) => t.label?.includes('연결 끊김')));
// 기대: 5 true
```

**완료 조건:** `LIVE: 2, STALE: 5` **그리고** (5) `2 true`, (6) `5 true`.

> **(5)가 실패해도 시스템 결함이 아닐 수 있다.** 판정 시점에 실제 낙상이
> 진행 중이면 `LIVE + DANGER`가 정직하게 나타난다 — 오라클 실패가 아니라
> 시스템이 옳게 동작하는 것이다. 이벤트가 없는 시점에 다시 잰다.

---

## 오늘 범위 밖 (합의된 이월)

- **I2 감지 근거 영상** — 코드는 완비. `EVENT_CLIPS_ENABLED`(클라우드)와
  `ML_WORKER_EVENT_CLIP_EXPORT_ENABLED`(엣지) env만 꺼져 있다. 꺼진 동안
  화면은 "근거 영상 저장이 아직 켜져 있지 않습니다"로 사실대로 말한다
  ("이 알림에 영상이 없다"고 거짓말하지 않는다).

- **멀티테넌시** — `EdgeFacilityTokenGuard`가 `x-facility-id`를 검증 없이
  신뢰한다. 단일 시설에서는 노출되지 않지만 **2번째 요양원 온보딩 전 필수**.
  (`EdgeIngestTokenGuard`는 서버에서 소유권을 해석하므로 이벤트 주입은 불가)
