# 에이전트 사무실: Claude Code를 위한 메모

너는 오픈소스 소프트웨어를 작업한다. 진짜 Claude Code 서브에이전트가 일하는 모습을 보여 주는 픽셀 아트 사무실이다.
이 저장소는 [Le Bureau des agents](https://github.com/devlikemasta/bureau-des-agents)(VibesMoney, MIT)의 한국어 포크다.
코드를 고치기 전에 이 파일을 읽는다. 사무실을 설치하고 실행하려면 README의 "Claude Code에게" 부분을 따른다.

## 명령

- `npm start`: Node를 확인하고, 클라이언트를 빌드하고, http://localhost:4848 에 서버를 띄운 뒤 브라우저를 연다.
- `npm run dev`: 서버 + Vite 핫 리로드, http://localhost:5174.
- `npm run check`: 타입 검사(클라이언트, 서버, 테스트). `npm run build`: 빌드. `npm test`: 테스트(`node --test`, 의존성 없음). 셋 다 pull request 전에 통과해야 한다.
- `npm run snapshot-demo`: `tests/fixtures/demo-store-snapshot.json`(데모 미션을 거친 스토어 상태)을 다시 만든다. 스토어를 일부러 바꿀 때만 쓴다.
- 쓸 만한 환경 변수: `PORT`(서버 포트), `BUREAU_DIR`(사무실 폴더, 기본값 `~/Documents/에이전트 사무실`). 미션 폴더는
  `미션/YYYY-MM-DD HH시 MM분 · 제목`. `BUREAU_RECORD=<폴더>`를 주면 claude와 오간 원문 줄과 사무실 이벤트를 쌍으로 남긴다
  (`tests/fixtures/claude/`의 골든 픽스처, `server/record.ts`).

Node 22.18 이상은 서버의 TypeScript를 바로 실행한다(타입 제거). 그래서 `server/`와 `shared/`에서는 import에 `.ts` 확장자를
붙이고, 진짜 컴파일이 필요한 문법(`enum`, `namespace`, 매개변수 프로퍼티)은 쓰지 않는다.

## 구조

- **`server/`**: `index.ts`(HTTP, WebSocket, 보안), `bureau.ts`(미션, 파일, 버전, 기록),
  `agents/`(`adapter.ts` = CLI에 중립인 경계, `claude.ts` = `claude -p`를 stream-json으로 실행하고 출력을 신호와 사무실 이벤트로 바꾼다, `registry.ts`가 어댑터를 가져오는 유일한 곳), `team.ts`(직무와 지시문).
- **`shared/protocol.ts`**: 서버와 브라우저 사이의 모든 메시지와 이벤트(`OfficeEvent`): `start`, `hire`,
  `act`, `report`, `leave`, `file`, `ask`, `end`… **`shared/activity.ts`**: 직무, 직무별 도구, 화면에 나오는 문구.
- **`src/state/store.ts`**(zustand)가 이벤트를 하나씩 정리해 엔진에 넘긴다(`src/state/bus.ts` → `src/engine/world.ts`).
- **`src/engine/`**: 세계(`world.ts`: 로봇, A* 이동, 잡담, 저녁 모드), 그리기(`render.ts`, `room.ts`,
  `furniture.ts`, `robots.ts`: 모든 픽셀 아트를 코드로 352 × 256 이미지에 그린다), 카메라와 연출(`camera.ts`), 클릭(`hits.ts`).
  사무실 안 표지판의 한글은 Galmuri 글꼴로 그린다(`font.ts`).
- **`src/ui/`**: React 인터페이스. `Office.tsx`(캔버스, 말풍선, 애니메이션 루프), `Dialog.tsx`(맥스와 입력창),
  `Rooms.tsx`(클릭하면 열리는 창), `interact.ts`(클릭마다 하는 일).
- **`src/audio/`**: ZzFX 효과음, 주크박스(`public/music/`), 맥스의 목소리(브라우저 음성 합성, Web Speech API `ko-KR`).
  대사는 `src/audio/voice.ts`의 `LINES`에 있다(둘러보기 자막도 여기서 가져간다). 원 프로젝트의 프랑스어 mp3는 지웠다.
- **`public/demo/mission.json`**: 녹화한 실제 미션(한국어로 옮김). 서버가 없을 때 다시 재생한다(`scripts/make-demo.ts`).

## 구독을 쓰지 않고 테스트하기

녹화한 미션은 똑같이 다시 재생된다(`H`, 그다음 "다시 재생"). 서버가 없으면 사무실은 데모 모드가 된다. 브라우저 콘솔에서
`window.__bureau`로 store, 세계, 카메라, `playReplay(mission, log, speed)`에 접근할 수 있다.
사무실을 한 장면씩 촬영하려면(시계를 조종하는 캡처 스크립트) `window.__CAPTURE`가 매 장면을 그리게 하고 음악 박자를 준다
(`Office.tsx`의 루프 참고).

## 규칙

- 사용자가 읽는 모든 글은 **한국어, 친근한 해요체, 짧은 문장**. 사무실은 처음 시작하는 사람을 위한 것이다.
- **화면에 전체 경로나 사용자 이름을 절대 보여 주지 않는다**: `tidy()`(`src/ui/tidy.ts`)와 `tilde()`(`src/ui/format.ts`).
- **가볍게**: 루프는 미션 중 초당 최대 24장, 쉴 때 8장을 그리고, 탭이 숨겨지면 아무것도 그리지 않는다. 한 장면에 약 1밀리초.
  3D 금지, 무거운 라이브러리 금지.
- **보안**: 서버는 127.0.0.1에서만 연결을 받고 WebSocket의 출처를 확인한다. 팀은 `--restricted`로, 자기 직무의 도구만 가지고
  일한다. 팀이 만든 사이트는 `/apercu/` 아래 샌드박스(CSP `sandbox`)에서 보여 준다.
- **zustand**: 새 배열이나 객체를 돌려주는 셀렉터는 `useShallow`를 거친다. 아니면 React가 무한 루프에 빠진다.
- **사무실 안에 외부 이미지 금지**: 새 가구는 `furniture.ts`에 코드로 그리고, `layout.ts`에 자리를 정하고,
  클릭할 수 있으면 `hits.ts`와 `interact.ts`에 항목을 넣는다.
- **음악, 목소리, 글꼴**: 공유할 권리가 있는 파일만 쓰고, 출처를 README에 적는다. 한글 글꼴은 Galmuri와 Pretendard(둘 다 SIL OFL 1.1).
- **내부 식별자는 프랑스어 그대로 둔다**: 역할 키(`chef`, `recherche`, `redaction`…), 에이전트 타입(`chercheur`…), 이벤트 이름,
  음성 대사 이름(`visite-1`…), 파일 이름. 저장된 데모 미션과 맞물려 있다.
