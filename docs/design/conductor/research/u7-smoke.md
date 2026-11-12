# U7 스모크: 진짜 서버로 돈 진짜 미션 두 개

2026-11-12, claude 2.1.322 / codex-cli 0.167.1, macOS. 다시 돌리려면
`node scripts/record-cli.ts --only claude:office-u7,codex:office-u7`(비용 경고를 보여 주고 `yes`를 기다린다).
스크립트는 임시 `BUREAU_DIR`과 `BUREAU_RECORD`로 `server/index.ts --dev`를 자식 프로세스로 띄우고, 브라우저처럼 WebSocket으로
설정(맥스와 claude 일꾼 haiku, 권한 auto, codex 일꾼 `gpt-6-luna`)을 보내고, 미션을 시작하고, `settle`을 기다린 뒤 `new`로 놓아준다.
결과는 `tests/fixtures/scenarios/real-u7-<cli>.logged.jsonl`(미션의 `Logged[]`)과 `real-u7-<cli>.meta.json`(관찰)이다.
요청은 둘 다 "일꾼 한 명(agent: <cli>, role: code)에게만 hello.txt에 안녕 한 줄"이다.

## 본 것

| 확인할 것 | claude 일꾼 | codex 일꾼 | 증거 |
|---|---|---|---|
| 맥스가 office_plan을 불렀다 | 1번, 할 일 `write-hello`(agent claude) | 1번, 할 일 `write-hello`(agent codex) | `logged`의 `act`(`mcp__office__office_plan`)와 `task` |
| 일꾼이 일했다 | Bash로 폴더 확인, Write로 hello.txt, Read로 확인 | `pwd && ls -la`, `printf '안녕\n' > hello.txt && cat hello.txt` | `logged`의 `act`, `meta.hires` |
| 파일이 생겼다 | `안녕\n`(7바이트), `file.by`가 그 일꾼 | 같음. codex는 Bash로 썼고 `by`는 수정 시각으로 찾았다 | `meta.helloText`, `logged`의 `file` |
| settle이 왔다 | 맥스의 마무리 글 그대로 | 같음 | `logged`의 `settle`, 그다음 `new`로 `leave`, `end`(`ms`는 미션 작업 시간) |
| MCP 요청에 Origin이 없다 | 6통, Origin 전부 없음 | 7통, Origin 전부 없음 | `meta.mcp.origins`가 `[null]`, User-Agent `claude-code/2.1.322 (sdk-cli)` |
| 걸린 시간 | 약 13초 | 약 17초 | `meta.ms` |

- 맥스는 계획을 보내고 턴을 끝냈고, 소식("모든 할 일이 끝났어요")으로 깨서 한 번만 마무리했다. codex 미션에서는 마무리 전에 `office_status`를 한 번 불렀다(되풀이하지 않았다).
- MCP 요청 순서는 U0b와 같다(`POST`들과 `GET` 하나). `GET`은 405로 답하고 claude는 문제없이 넘어갔다.
- codex 일꾼은 handback 블록 없이 끝났다. 진행자는 마지막 답 전체를 요약으로 받아 할 일을 done으로 했다(설계대로).
- codex의 `leave.tokens`는 48723이다. codex의 `input_tokens`에 캐시된 입력(지시문)이 들어가서 claude(672)보다 훨씬 크다.
- 승인 요청은 두 미션 모두 0건이었다(`permission: auto`, 폴더 안의 쓰기).
- 이어서 시키기(follow-up)는 하지 않았다. codex의 `exec resume` cwd 동작은 이번에도 확인하지 않았다.

## 찾은 것과 고친 것

첫 claude 실행에서 일꾼의 Bash `act.detail`이 `cd "<미션 폴더 전체 경로>" && …`로 화면까지 갔다(픽스처를 지울 때만 가려졌다).
진행자 셸은 이벤트를 `JSON.stringify`한 글에 `relToFolder`를 거는데, JSON 안에서는 경로 뒤의 따옴표가 `\"`가 되어
경로 끝을 알아보는 앞보기(`[/"'\s]`)에 걸리지 않았다. 앞보기에 `\`를 더했다(`shared/activity.ts`).
`tests/office-server.test.ts`의 codex 명령에 `cd "{{cwd}}"`를 넣어 고치기 전에는 실패하는 것을 확인했고, 진짜 claude 미션을 한 번 더 돌려
`detail`이 `cd "." && pwd && ls -la`로 나오는 것을 봤다. 커밋한 claude 픽스처는 이 두 번째 실행이다.

## 지우기

`record-cli.ts`의 `makeScrub`로 지웠다: 미션 폴더(`/work/mission`), 임시 폴더, 홈 폴더, 사용자 이름, git 이름과 이메일, 토큰 모양, 포트.
지운 뒤 홈 경로, 사용자 이름, git 이름, 이메일, `/var/folders`, `/private/`, `/Users/`, `sk-ant`, `Bearer`, 이메일 모양,
`/lead/<32자>`, JWT 모양으로 grep했고 네 파일 모두 아무것도 나오지 않았다. 지우기 전의 기록에도 임시 폴더와 홈 경로는 없었다(`meta.pathsInLog: 0`).
