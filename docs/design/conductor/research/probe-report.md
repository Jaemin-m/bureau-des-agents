# U0b 프로브 보고서: 진짜 CLI 스트림 녹화

2026-11-12, claude 2.1.322 / codex-cli 0.167.1 / gemini 0.55.1, macOS. 녹화는 `scripts/record-cli.ts`가 만들었고 다시 돌릴 수 있다
(`node scripts/record-cli.ts`는 실행할 것과 비용 경고만 보여 주고 `yes`를 기다린다). 원문은 `tests/fixtures/<cli>-<버전>/<시나리오>.raw.jsonl`이다.
각 줄은 `{"dir":"stdout"|"stdin"|"stderr","line":"<원문>"}`이고, 시나리오마다 명령과 관찰을 담은 `<시나리오>.meta.json`이 있다.
판정은 이 실행에서 직접 본 것만으로 한다. VERIFIED는 증거 파일에 줄이 있다는 뜻이고, 한 번 돌린 결과라서 드물게만 일어나는 동작은 못 잡는다.

모델은 claude `haiku`, codex `gpt-6-luna`(reasoning low)였다. gemini는 모델 호출 전에 인증에서 막혔다.
지운 방식은 맨 아래 「지우기」 절에 있다.

## 열린 질문 1: claude의 MCP over HTTP

| # | 질문 | 판정 | 증거 |
|---|---|---|---|
| 1d-1 | `--restricted`에서 `--mcp-config`(type `http`, bearer 헤더)와 `--strict-mcp-config`가 받아들여지고 도구가 보이는가 | VERIFIED | `claude-2.1.322/mcp-http.raw.jsonl`: init의 `mcp_servers`가 `[{name:office,status:connected,source:dynamic}]`, `tools`에 `mcp__office__office_ping` |
| 1d-2 | `--allowedTools mcp__office__office_ping`이 승인 요청을 없애는가 | VERIFIED | `mcp-http.raw.jsonl`은 `can_use_tool` 0건. 대조군 `mcp-http-noallow.raw.jsonl`은 같은 호출에 `can_use_tool` 1건(`tool_name:mcp__office__office_ping`). 허용 목록이 없애는 것이다 |
| 1d-3 | 호출 결과가 모델에게 돌아가는가 | VERIFIED | `mcp-http.server.jsonl`에 `tools/call`과 응답, `mcp-http.raw.jsonl`의 최종 `result`가 `PONG-7731:hello` |
| 1d-4 | 모델 호출 없이 확인할 수 있는가 | VERIFIED(일부) | `mcp-http-noturn.server.jsonl`: 사용자 메시지를 보내지 않았는데 서버가 `initialize`, `notifications/initialized`, `tools/list`를 받았다. 연결과 목록은 모델 호출 없이 서버 쪽 기록으로 확인된다. 하지만 `init` 이벤트는 첫 사용자 메시지 뒤에야 나오고(`mcp-http-noturn.raw.jsonl`은 빈 파일), 승인 요청이 없는지는 호출을 시켜 봐야 안다 |
| 1d-5 | stdio 중계(shim) 대체안 | NOT VERIFIED | http가 되어서 돌리지 않았다. 스크립트의 `--mcp-stdio-shim` 경로는 작성만 했고 한 번도 실행하지 않았다 |

claude가 우리 서버에 보낸 요청 순서(`mcp-http.server.jsonl`): `POST server/discover`(우리는 `-32601`로 답했고 문제없이 넘어감), `initialize`(protocolVersion `2025-11-25`),
`notifications/initialized`(202), `GET /mcp`(Accept `text/event-stream`, 우리는 405로 답했고 문제없이 넘어감), `tools/list`, `tools/call`(`_meta`에 `claudecode/toolUseId`).
전부 `Authorization: Bearer`가 붙어 왔다. JSON 응답(SSE 없음)만으로 충분했다. 최소 서버는 `initialize`, `tools/list`, `tools/call`, 알림에 202, GET에 405면 된다.

예상 밖의 발견. 사용자의 claude.ai 커넥터가 제한 모드에서도 붙는다. `interrupt.raw.jsonl`과 `midturn-stdin.raw.jsonl`의 두 번째 턴 `init`에서
`mcp_servers`가 24개(`source:claudeai`, 대부분 `needs-auth`, 일부 `connected`), `tools`가 97~154개로 늘어난다. 첫 턴의 `init`에는 `[]`로 나온다(비동기로 늦게 붙는다).
`--strict-mcp-config`는 이 실행들에 없었다(오늘의 `server/claude.ts`와 같다). 오늘의 사무실은 `--restricted --tools <목록>`이라고 해도 모델에게 사용자 커넥터 도구가 보일 수 있다는 뜻이다
(이름은 지웠고 개수와 상태만 남겼다). `--mcp-config ... --strict-mcp-config`를 쓴 `mcp-http*` 실행은 `office` 하나만 보였다(1턴짜리라서 커넥터가 붙기 전에 끝났을 가능성은 남는다).
어댑터는 `--strict-mcp-config`를 항상 붙이는 쪽이 안전하다. 오늘의 사무실도 같은 구멍이다. 승인 모드가 막아 주는지는 이번에 확인하지 않았다.

## 열린 질문 2: 나머지

### claude

| # | 질문 | 판정 | 증거와 관찰 |
|---|---|---|---|
| 1a | `can_use_tool` 왕복 | VERIFIED | `permission.raw.jsonl`: `control_request`(`subtype:can_use_tool`, 키 `tool_name, display_name, input, description, permission_suggestions, tool_use_id`) → 우리가 `control_response`(allow, `updatedInput`)로 답함 → `tool_result` 성공, 파일 생성됨. `control_cancel_request`는 오지 않았다. `--permission-mode manual`일 때 Write가 묻는다. 사무실의 `acceptEdits`는 폴더 안 Write를 묻지 않는다(1e에서 확인) |
| 1b | interrupt | VERIFIED | `interrupt.raw.jsonl`: 보낸 `control_request{subtype:interrupt}`에 곧바로 `control_response{subtype:success, response:{still_queued:[]}}`, 이어서 `user` 메시지 `[Request interrupted by user]`, 마지막에 `result{subtype:error_during_execution, is_error:true, terminal_reason:aborted_streaming}`. 같은 프로세스에 다음 사용자 메시지를 보내자 새 `init`과 정상 `result{success}`가 왔다. 즉 interrupt는 턴만 끝내고 프로세스는 산다 |
| 1c | 턴 도중 stdin 메시지 | VERIFIED: 큐에 쌓인다 | `midturn-stdin.raw.jsonl`: 첫 턴이 도는 중(첫 글 조각 직후)에 둘째 `user`를 보냈다. 첫 턴은 1부터 120까지 끝까지 쓰고 `result{success}`를 냈다(합치지도 무시하지도 않음). 그다음 새 `init`과 둘째 턴이 시작되어 `SECOND-MESSAGE-RECEIVED`로 답하고 두 번째 `result`를 냈다. 메시지마다 `result`가 하나이고 순서대로(FIFO)다. 큐에 들어갔다는 알림 이벤트는 없다(`--replay-user-messages`는 쓰지 않았다). `result.queued_turn_count`는 큐에 하나 있을 때도 0이었다. 믿지 말 것 |
| 1e | 사무실을 거친 진짜 쌍 | VERIFIED | `tests/fixtures/claude/real-hire-one-1.{raw,logged}.jsonl`. 진짜 `Bureau`, `BUREAU_RECORD`, chef와 team 모두 haiku, 고용 1명. 골든 테스트가 오늘의 Normalizer로 `logged`와 정확히 일치했다(차이 없음). 아래 「1e 관찰」 참고 |

관찰 몇 가지(전부 위 파일에서 확인).
- 턴마다 `system/init`이 다시 온다(`interrupt`, `midturn-stdin` 모두 두 번째 턴에 새 `init`). Normalizer는 `init`마다 `init` 이벤트를 낸다. 어댑터가 턴 경계를 알려면 `result`를 써야 한다.
- 제한 모드의 `init`에도 사용자 스킬, 슬래시 명령, 플러그인 목록이 실려 온다(수백~수만 바이트). 녹화에서 비웠다.
- `result`에 `credential_expires_at`이 있다(녹화에서 가렸다).
- `rate_limit_event`는 `rateLimitType:five_hour`, `unifiedWindows.five_hour.utilization`처럼 오늘의 Normalizer가 읽는 모양 그대로다.

### codex (`codex exec --json`)

| # | 질문 | 판정 | 증거와 관찰 |
|---|---|---|---|
| 2a | 첫 턴 이벤트와 필드 | VERIFIED | `codex-0.167.1/first-turn.raw.jsonl`. 아래 이벤트 표 |
| 2b | `exec resume <thread_id> --json` | VERIFIED(조건부) | `resume.raw.jsonl`: 같은 `thread_id`로 `thread.started`가 다시 오고 문맥이 이어진다(`hello.txt`를 기억함). 단 샌드박스는 이어지지 않는다(아래) |
| 2c | resume에서 샌드박스 | 설계와 다름 | `exec resume`에는 `-s`와 `-C`가 없다(`codex exec resume --help`). `--ignore-user-config`로 돌린 resume은 읽기 전용으로 떨어져 쓰기가 막혔다(`resume.raw.jsonl`: 모델이 "읽기 전용이라 못 쓴다"고 답함, 파일 그대로). `-c sandbox_mode="workspace-write"`를 주자 쓰기에 성공했다(`resume-sandbox-override.raw.jsonl`, `meta.json`의 `fileAfter`). 어댑터는 resume마다 `-c sandbox_mode=...`를 줘야 한다. 첫 턴의 `-C`가 resume에서 어떻게 되는지는 이 실행에서 가를 수 없다(프로세스 cwd가 같은 폴더였다): INCONCLUSIVE |
| 2d | SIGTERM | VERIFIED | `sigterm.raw.jsonl`: 오래 도는 명령(`sleep 60`)의 `item.started` 뒤 SIGTERM → 종료 신호 `SIGTERM`, `turn.completed`나 `turn.failed`나 `error`는 오지 않았고 마지막 줄이 `item.started`였다. codex가 띄운 `sleep 60`은 고아로 남았다(`meta.json`의 `orphanedChildren:1`, ppid 1, 스크립트가 정리함). 어댑터는 `turn_end`를 직접 만들어야 하고, 프로세스 그룹 전체를 끝내야 한다 |
| 2e | 헤드리스 인증 | VERIFIED | 사용자의 기존 로그인(`CODEX_HOME`)으로 됐다. 스크립트는 `--ignore-user-config`로 돌려 사용자 MCP 서버를 띄우지 않았다 |

이벤트(전부 한 줄에 하나, `type` 키):

| type | 필드 |
|---|---|
| `thread.started` | `thread_id` |
| `turn.started` | (없음) |
| `item.started`, `item.completed` | `item{id:"item_N", type, ...}` |
| `item.type=command_execution` | `command`(예: `/bin/zsh -lc "printf ..."`), `aggregated_output`, `exit_code`(시작 때 null), `status`(`in_progress`, `completed`) |
| `item.type=agent_message` | `text`. 조각 없이 `item.completed`에서 통째로 온다(`item.started`도 `item.updated`도 없음) |
| `turn.completed` | `usage{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}` |

이번에 보지 못한 것: `turn.failed`, `error`, `file_change`와 `reasoning` 항목, `item.updated`(셸로 파일을 만들었다). 샌드박스: `-s workspace-write -C <dir>`로 첫 턴, 승인 요청은 한 번도 나오지 않았다
(샌드박스 안의 명령만 시켰다). 프롬프트는 stdin(`-`)으로 줬고 stdin을 닫았다. 프롬프트를 stdin으로 주는 방식은 resume에서도 됐다.

### gemini

| # | 질문 | 판정 | 증거 |
|---|---|---|---|
| 3a | 사용자의 기존 로그인으로 헤드리스 인증 | NOT VERIFIED(실패) | `gemini-0.55.1/auth-minimal.raw.jsonl`. 가장 작은 옵션(`-p ... -o stream-json --skip-trust`)으로도 stdout 이벤트 없이 종료 코드 1. stderr: `Error authenticating: IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals ... migrate to the Antigravity suite` (`reasonCode: UNSUPPORTED_CLIENT`, `tierId: free-tier`). 사용자의 설정은 `oauth-personal`이다. 계정 등급의 문제이지 헤드리스 옵션의 문제가 아니다. 모델은 호출되지 않았다 |
| 3b | `-o stream-json` 첫 턴 이벤트 | NOT VERIFIED | 인증에서 막혀 한 줄도 받지 못했다. 이벤트 6종의 모양은 `explore-clis.md`의 소스 조사(`[source]`)로만 남아 있다 |
| 3c | `-r <uuid>`로 이어하기, `--session-id` 지정 | NOT VERIFIED | 위와 같음 |
| 3d | 턴 도중 SIGTERM의 `result` | NOT VERIFIED | 위와 같음 |

결론: 이 컴퓨터에서 gemini 어댑터(U11)는 다른 인증(예: API 키)이 생기기 전에는 실제 스트림으로 검증할 수 없다. 사용자에게 알릴 일이다. 그전까지 매퍼는 소스 기반 가정으로만 쓸 수 있다.

## 1e 관찰(사무실을 통한 진짜 미션)

`tests/fixtures/claude/real-hire-one-1.logged.jsonl`의 이벤트: `start`(bureau), `init`, `hire`(developpeur), `act`(Bash)와 `act_done`, `file`(bureau), `leave`, `act_done`(chef), `think`, `say`, `end`(bureau).
- 골든 테스트가 그대로 통과한다. 오늘의 Normalizer와 진짜 스트림 사이에 어긋난 것은 없다.
- 개발자 팀원이 Write 대신 Bash로 파일을 만들었다. 허락 요청은 없었다(`acceptEdits`).
- `file` 이벤트의 `by`가 `chef`다. 파일은 팀원이 Bash로 썼다. `writers`는 Write, Edit에서만 작성자를 배우므로 Bash로 쓴 파일은 팀장 것으로 표시된다. 오늘의 동작이고 이번 단위에서는 고치지 않았다.

## 지우기

원문은 쓰기 전에 줄 단위로 지운다: 임시 폴더와 그 `realpath`(`<TMP>/<cli>-<시나리오>`), 홈 폴더와 그 슬러그(`<HOME>`, `<HOME-SLUG>`), 사용자 이름과 git 사용자 이름(`<USER>`),
이메일(`<EMAIL>`), 토큰처럼 생긴 문자열과 bearer(`<TOKEN>`), 포트(`127.0.0.1:<PORT>`). 골든 쌍은 미션 폴더를 `/work/mission`으로 바꿔서
Normalizer 테스트의 `folder`와 맞춘다. 스트림 조각(`text_delta`, `input_json_delta`)은 아무 데서나 끊겨 경로가 두 조각에 걸치므로, 한 블록의 조각을 이어 붙여 지운 뒤 같은 개수로 다시 나눈다
(조각의 길이는 균등하게 바뀌지만 내용 합은 같다). claude 줄에서는 사용자 환경이 담긴 값도 비웠다: `init`의 `slash_commands`, `skills`, `plugins`, `commands_changed`의 `commands`,
claude.ai 커넥터 이름(개수와 상태는 남김), 생각 서명, `credential_expires_at`.
