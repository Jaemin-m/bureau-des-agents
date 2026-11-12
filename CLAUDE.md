# 에이전트 사무실: Claude Code를 위한 메모

너는 오픈소스 소프트웨어를 작업한다. 진짜 에이전트 CLI(Claude Code, Codex)가 일하는 모습을 보여 주는 픽셀 아트 사무실이다.
이 저장소는 [Le Bureau des agents](https://github.com/devlikemasta/bureau-des-agents)(VibesMoney, MIT)의 한국어 포크다.
코드를 고치기 전에 이 파일을 읽는다. 사무실을 설치하고 실행하려면 README의 "Claude Code에게" 부분을 따른다.

## 명령

- `npm start`: Node를 확인하고, 클라이언트를 빌드하고, http://localhost:4848 에 서버를 띄운 뒤 브라우저를 연다.
- `npm run dev`: 서버 + Vite 핫 리로드, http://localhost:5174.
- `npm run check`: 타입 검사(클라이언트, 서버, 테스트). `npm run build`: 빌드. `npm test`: 테스트(`node --test`, 의존성 없음). 셋 다 pull request 전에 통과해야 한다.
- `npm run snapshot-demo`: `tests/fixtures/demo-store-snapshot.json`(데모 미션을 거친 스토어 상태)을 다시 만든다. 스토어를 일부러 바꿀 때만 쓴다.
- 쓸 만한 환경 변수: `PORT`(서버 포트), `BUREAU_DIR`(사무실 폴더, 기본값 `~/Documents/에이전트 사무실`). 미션 폴더는
  `미션/YYYY-MM-DD HH시 MM분 · 제목`. `BUREAU_RECORD=<폴더>`를 주면 미션의 이벤트(`Logged[]`), 세션마다 CLI와 오간 원문 줄,
  맥스의 MCP 요청 헤더를 남긴다(`server/record.ts`). `CLAUDE_BIN`, `CODEX_BIN`은 실행 파일을 직접 가리킨다(테스트의 가짜 CLI).
- `node scripts/record-cli.ts --only claude:office-u7,codex:office-u7`: 진짜 서버로 작은 미션을 돌려 `tests/fixtures/scenarios/`에
  남긴다(구독 사용량을 쓴다, 묻고 나서 돈다).

Node 22.18 이상은 서버의 TypeScript를 바로 실행한다(타입 제거). 그래서 `server/`와 `shared/`에서는 import에 `.ts` 확장자를
붙이고, 진짜 컴파일이 필요한 문법(`enum`, `namespace`, 매개변수 프로퍼티)은 쓰지 않는다.

## 구조

- **`server/`**: `index.ts`(HTTP, WebSocket, 보안, 맥스의 MCP 끝점 `POST /lead/<토큰>/mcp`), `bureau.ts`(미션 목록, 설정, 기록,
  미션 폴더의 파일과 버전), `record.ts`(개발용 녹화), `team.ts`(직무마다 일꾼의 성격).
  - `agents/`: `adapter.ts`(CLI에 중립인 경계 `AgentSession`과 신호 `WorkerSignal`), `claude.ts`(`claude -p` stream-json, 프로세스 하나가 여러 턴),
    `codex.ts`(`codex exec --json`, 턴마다 프로세스 하나, `exec resume`으로 이어감), `registry.ts`(어댑터를 가져오는 유일한 곳. gemini는 아직 지원하지 않음).
  - `conductor/`: 미션 하나의 진행자. `model.ts`(상태), `dag.ts`(계획 검사, 할 일 상태), `step.ts`(순수 코어: 입력 하나 → 새 상태, 이벤트, 효과),
    `text.ts`(맥스를 깨우는 글, 일꾼의 handback 블록 읽기), `prompts.ts`(맥스와 일꾼의 지시문), `lead-mcp.ts`(맥스의 도구 `office_plan`,
    `office_message`, `office_cancel`, `office_status`), `shell.ts`(효과를 실행하고 어댑터의 신호를 코어에 넣는 셸, 상태 저장), `boot.ts`(재시작 때 남은 프로세스 정리).
  - `workspaces.ts`, `roots.ts`: git worktree와 안전한 경로(저장소 미션용, 아직 연결하지 않음).
- **미션 하나가 도는 법**: 브라우저의 `start`가 `Bureau.start`로 미션 폴더를 만들고 `Conductor.create`를 부른다. 진행자가 맥스(claude)를
  띄우고, 맥스는 MCP의 `office_plan`으로 할 일(직무, CLI, 의존 관계)을 보내고 턴을 끝낸다. 진행자가 준비된 할 일마다 일꾼을 고용해
  자기 프로세스로 띄우고(같은 미션 폴더, 직무의 도구만, MCP 없음), 일꾼은 마지막 답의 `handback` 블록으로 끝냄·질문·막힘을 알린다.
  끝난 일과 질문은 소식으로 모여 맥스를 깨운다(일꾼의 글은 `data` 블록, 지시가 아니라 자료). 모두 조용해지면 맥스가 마무리하고
  `settle`이 온다. `end`와 마지막 `leave`는 미션을 놓아줄 때(새 미션, 서버 종료)만 온다. 브라우저의 `say`(`to`가 있으면 그 일꾼에게),
  `answer`, `reply`, `stop`(`who`), `resume`은 모두 `Conductor.input`으로 간다. 제어 상태는 `.bureau/missions/<id>.state.json`에 있고
  화면으로 가지 않는다(세션 id, 경로, pid).
- **`shared/protocol.ts`**: 서버와 브라우저 사이의 모든 메시지와 이벤트(`OfficeEvent`): `start`, `hire`,
  `act`, `report`, `leave`, `file`, `ask`, `end`, 그리고 진행자의 `worker`, `task`, `msg`, `settle`… **`shared/activity.ts`**: 직무, 직무별 도구, 화면에 나오는 문구.
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

`npm test`는 가짜 CLI(`tests/support/fake-agent.ts`, 대본대로 말한다)로 진짜 어댑터, 진행자, 서버를 돌린다. `tests/office-server.test.ts`는
`server/index.ts`를 자식 프로세스로 띄우고 WebSocket으로 미션 하나를 끝까지 돌린다.
녹화한 미션은 똑같이 다시 재생된다(`H`, 그다음 "다시 재생"). 서버가 없으면 사무실은 데모 모드가 된다. 브라우저 콘솔에서
`window.__bureau`로 store, 세계, 카메라, `playReplay(mission, log, speed)`에 접근할 수 있다.
사무실을 한 장면씩 촬영하려면(시계를 조종하는 캡처 스크립트) `window.__CAPTURE`가 매 장면을 그리게 하고 음악 박자를 준다
(`Office.tsx`의 루프 참고).

## 규칙

- 사용자가 읽는 모든 글은 **한국어, 친근한 해요체, 짧은 문장**. 사무실은 처음 시작하는 사람을 위한 것이다.
- **화면에 전체 경로나 사용자 이름을 절대 보여 주지 않는다**: `tidy()`(`src/ui/tidy.ts`)와 `tilde()`(`src/ui/format.ts`).
- **가볍게**: 루프는 미션 중 초당 최대 24장, 쉴 때 8장을 그리고, 탭이 숨겨지면 아무것도 그리지 않는다. 한 장면에 약 1밀리초.
  3D 금지, 무거운 라이브러리 금지.
- **보안**: 서버는 127.0.0.1에서만 연결을 받고 WebSocket의 출처를 확인한다. 맥스의 MCP 끝점은 토큰(프로세스마다, 끝나면 회수),
  루프백 Host, Origin 없음을 모두 요구한다. 일꾼은 claude면 `--restricted`와 자기 직무의 도구만, codex면 샌드박스(`workspace-write`)
  안에서만 일한다. 팀이 만든 사이트는 `/apercu/` 아래 샌드박스(CSP `sandbox`)에서 보여 준다.
- **zustand**: 새 배열이나 객체를 돌려주는 셀렉터는 `useShallow`를 거친다. 아니면 React가 무한 루프에 빠진다.
- **사무실 안에 외부 이미지 금지**: 새 가구는 `furniture.ts`에 코드로 그리고, `layout.ts`에 자리를 정하고,
  클릭할 수 있으면 `hits.ts`와 `interact.ts`에 항목을 넣는다.
- **음악, 목소리, 글꼴**: 공유할 권리가 있는 파일만 쓰고, 출처를 README에 적는다. 한글 글꼴은 Galmuri와 Pretendard(둘 다 SIL OFL 1.1).
- **내부 식별자는 프랑스어 그대로 둔다**: 역할 키(`chef`, `recherche`, `redaction`…), 에이전트 타입(`chercheur`…), 이벤트 이름,
  음성 대사 이름(`visite-1`…), 파일 이름. 저장된 데모 미션과 맞물려 있다.
