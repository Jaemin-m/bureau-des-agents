# 설치된 에이전트 CLI의 헤드리스 능력 조사 (claude / codex / gemini / git worktree / Orca)

버전: claude 2.1.322, codex-cli 0.167.1, gemini 0.55.1, git 2.45.1. Orca.app 번들 CLI 확인됨.
모델 실행(구독/쿼터 소모)은 전혀 하지 않았다. `--help`, 설치 패키지 소스/문서, 로컬 JSON 스키마 생성, 임시 저장소의 git 실험만 사용했다.

근거 표기: **[help]** = `--help` 출력으로 확인, **[source]** = 설치된 소스/번들/스키마/문서로 확인, **[repo]** = 이 저장소 코드로 확인, **[inferred]** = 추론(실제 실행 미확인).

---

## Components Found

### 1) claude (2.1.322)

현재 사무실이 쓰는 방식 [repo: server/claude.ts:75-100]
`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --permission-mode <m> --restricted --tools <csv> --agents <json> --append-system-prompt <txt> [--model] [--resume <id>] [--allowedTools] --disallowedTools AskUserQuestion`

stdin(줄 단위 JSON) [repo: claude.ts:121-148]
- 사용자 메시지: `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`
- 허락 응답: `{"type":"control_response","response":{"subtype":"success","request_id":..,"response":{"behavior":"allow","updatedInput":{..}}}}` 또는 `{"behavior":"deny","message":".."}`. 모르는 요청은 `subtype:"error"`로 거절.
- 중단: `{"type":"control_request","request_id":..,"request":{"subtype":"interrupt"}}`
- 종료: `stdin.end()` 후 5초 뒤 SIGTERM.

stdout 이벤트(줄 단위 JSON) [repo: Normalizer.handle, claude.ts:212-345]
- `system` (subtype `init`: session_id, model, apiKeySource / `task_started`: task_id, tool_use_id / `task_notification`: status, usage{total_tokens,tool_uses,duration_ms})
- `stream_event` (`event.type` = content_block_start/delta; `thinking`, `text_delta`) - `--include-partial-messages` 필요
- `assistant` (content: `text`, `tool_use{id,name,input}`), `user` (content: `tool_result{tool_use_id,is_error}`)
- `result` (subtype, is_error, result, duration_ms), `rate_limit_event` (unifiedWindows.five_hour)
- `control_request` (`can_use_tool`: tool_name, input, tool_use_id), `control_cancel_request`
- 서브에이전트 귀속: 모든 메시지의 `parent_tool_use_id` (없으면 메인). `--forward-subagent-text` 옵션이 있다 [help].

도움말에서 확인한 플래그 [help: `claude --help`]
- 헤드리스: `-p/--print`, `--input-format text|stream-json`, `--output-format text|json|stream-json`, `--replay-user-messages`(stdin 메시지를 stdout으로 되돌려 ack), `--json-schema`, `--max-budget-usd`, `--no-session-persistence`.
- 세션: `-r/--resume [id|name]`, `-c/--continue`, `--session-id <uuid>`(미리 지정 가능), `--fork-session`, `-n/--name`.
- 권한: `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`, `--permission-prompts host|none`("host"= SDK 호스트 또는 `--permission-prompt-tool`이 답함, "none"= 묻는 것은 자동 거부), `--allowedTools`, `--disallowedTools`, `--dangerously-skip-permissions`. (`--permission-prompt-tool`은 `--help`에는 안 보이고 사무실 코드가 `stdio`로 쓴다 [repo]; `--permission-prompts` 설명에 이름만 나온다.)
- 도구 제한/샌드박스: `--tools "<csv>"|""|default`, `--restricted`(Bash 등 코드 실행 도구·WebFetch 제거, 사용자/프로젝트 설정 무시, 파일 도구를 작업 폴더+`--add-dir`에 가둠), `--add-dir`, `--bare`, `--safe-mode`, `--setting-sources`, `--settings`.
- 작업 폴더: 별도 `--cwd` 플래그는 없다. 프로세스 `cwd`로 지정 + `--add-dir`. `-w/--worktree [name]`은 claude가 직접 worktree를 만든다 (사무실은 자체 관리가 낫다).
- 모델: `--model <alias|full>`, `--effort low|medium|high|xhigh|max`, `--fallback-model`.
- MCP: `--mcp-config <files-or-json...>`, `--strict-mcp-config`; 서브커맨드 `claude mcp add/add-json/...`(영구 설정 변경이라 피한다).
- 시스템 프롬프트: `--system-prompt`, `--append-system-prompt`, `--agents <json>`.
- 백그라운드 세션: `--bg`, `claude agents|attach|logs|stop|rm|respawn` (Claude 전용 대안이지만 stream-json 제어가 불가하므로 사무실 용도에는 부적합 [inferred]).

### 2) codex (codex-cli 0.167.1)

두 가지 헤드리스 경로가 있다.

**(A) `codex exec --json` (단발 프로세스, 이벤트 JSONL)** [help: `codex exec --help`, `codex exec resume --help`]
- 프롬프트는 인자 또는 stdin(`-`). stdin이 파이프이고 인자도 있으면 stdin이 `<stdin>` 블록으로 덧붙는다. 즉 **stdin은 시작 시 1회만 읽는다** (추가 입력 채널 아님).
- `--json`(JSONL 이벤트), `-o/--output-last-message <FILE>`, `--output-schema <FILE>`(최종 응답 JSON Schema), `--ephemeral`(세션 파일 안 남김).
- `-C/--cd <DIR>`, `--add-dir`, `-m/--model`, `-s/--sandbox read-only|workspace-write|danger-full-access`, `--approve-for-me`, `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `-c key=value`(TOML 오버라이드), `--worktree`("새 관리형 Git worktree에서 실행"), `-p/--profile`, `--oss`.
- 서브커맨드: `exec resume [SESSION_ID|--last] [PROMPT]`(id는 UUID 또는 thread 이름, `-`면 stdin), `exec fork`, `exec review`.
- `exec`에는 `-a/--ask-for-approval` 플래그가 **없다** (대화형 `codex`에는 있다). 헤드리스 exec의 승인 정책은 `-c approval_policy=...`로 줄 수 있을 것으로 보이나 미확인 [inferred].
- 이벤트 종류 [source: 바이너리 문자열 `strings -a .../vendor/aarch64-apple-darwin/bin/codex`에서 확인한 토큰; 필드 구조는 inferred]:
  `thread.started`(thread_id), `turn.started`, `turn.completed`(usage: input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens), `turn.failed`, `item.started/updated/completed`, `error`.
  item 타입: `agent_message`, `reasoning`, `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list`, `collab_tool_call` (바이너리에 모두 존재).
  정확한 필드(예: item.id, command, aggregated_output, exit_code, status)는 실제 실행 없이는 확인하지 못했다.

**(B) `codex app-server` (JSON-RPC 2.0, 장기 실행 프로세스, 승인/스티어링 지원)** [help: `codex app-server --help`; source: `codex app-server generate-json-schema [--experimental] --out <dir>`로 생성한 스키마. 로컬 생성물: `/private/tmp/claude-501/-Users-jaemin-project-bureau-des-agents/9accd846-6a8b-44bd-85ee-d238aa09b042/scratchpad/upgrade/codex-schema/` 및 `codex-schema-exp/`]
- 전송: `--listen stdio://`(기본) | `unix://[PATH]` | `ws://IP:PORT` | `off`. `codex app-server generate-ts`로 TS 바인딩도 생성 가능. `app-server daemon start|stop|...`로 상주 데몬도 있다.
- 클라이언트 요청(발췌): `initialize`, `thread/start`, `thread/resume`, `thread/fork`, `thread/list|read|turns/list`, `thread/archive|delete`, `thread/name/set`, `thread/inject_items`, `thread/compact/start`, `turn/start`, **`turn/steer`**(진행 중인 턴에 메시지 주입, `expectedTurnId` 필수), **`turn/interrupt`**, `review/start`, `model/list`, `command/exec`(+write/terminate), `fs/*`, `mcpServerStatus/list`, `config/*`.
- `thread/start` 인자: `cwd`, `model`, `sandbox`(read-only|workspace-write|danger-full-access), `approvalPolicy`(`untrusted|on-request|never` 또는 granular{sandbox_approval,rules,mcp_elicitations,request_permissions,skill_approval}), `approvalsReviewer`, `baseInstructions`, `developerInstructions`, `config`(TOML 오버라이드 맵), `ephemeral`; 실험 플래그를 켜면 `dynamicTools`, `permissions`, `multiAgentMode` 등이 추가된다.
- `turn/start` 인자: `threadId`, `input[]`(필수), `cwd`, `model`, `effort`, `approvalPolicy`, `sandboxPolicy`, `outputSchema`, `summary`, `personality`.
- 서버 알림(발췌): `thread/started`, `thread/status/changed`(notLoaded|idle|systemError|active{activeFlags}), `turn/started`, `turn/completed`(Turn.status: completed|interrupted|failed|inProgress), `turn/diff/updated`, `turn/plan/updated`, `item/started|completed`, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta|textDelta`, `item/commandExecution/outputDelta`, `item/fileChange/outputDelta|patchUpdated`, `item/mcpToolCall/progress`, `thread/tokenUsage/updated`(last/total: inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens, totalTokens; modelContextWindow), `account/rateLimits/updated`, `serverRequest/resolved`, `error`, `warning`.
- ThreadItem 타입: userMessage, agentMessage, reasoning, plan, commandExecution(command, cwd, status, exitCode, aggregatedOutput, durationMs), fileChange(changes, status), mcpToolCall(server, tool, arguments, result, status), dynamicToolCall, collabAgentToolCall, subAgentActivity, webSearch, imageView, contextCompaction …
- **서버 -> 클라이언트 요청(호스트가 응답해야 함)**: `item/commandExecution/requestApproval`(command, cwd, reason, availableDecisions, proposedExecpolicyAmendment…) 응답 `{decision: accept | acceptForSession | acceptWithExecpolicyAmendment | decline | cancel…}`; `item/fileChange/requestApproval`(accept|acceptForSession|decline|cancel — cancel은 턴 즉시 중단); `item/permissions/requestApproval`; `item/tool/requestUserInput`(questions[{id,header,question,options[{label,description}],isSecret}] -> `answers`; 에이전트가 사용자에게 묻는 채널); `mcpServer/elicitation/request`; `item/tool/call`(**dynamicTools**: 호스트가 정의한 도구를 모델이 호출하면 호스트가 `{contentItems,success}`로 응답); 구형 `applyPatchApproval`, `execCommandApproval`.
- 후속 메시지: 실행 중이면 `turn/steer`, 끝났으면 같은 thread에 `turn/start`(프로세스가 살아 있으면 컨텍스트 유지) 또는 새 프로세스에서 `thread/resume`.

기타 codex 도구 [help]
- `codex queue --thread <id|name> --message <text> [--resume]`: 기존 세션에 메시지를 **큐잉**(app-server 데몬 필요). 사무실이 직접 쓰기엔 app-server 직결이 더 낫다 [inferred].
- `codex mcp add|list|get|remove|login`: **외부 MCP 서버를 codex에 등록**하는 명령(영구 config 변경). `codex mcp-server`(codex를 MCP 서버로 노출)는 0.167.1 도움말에 서브커맨드로 나오지 않는다 (실행하면 일반 도움말이 나온다).
- MCP를 한 번의 실행에만 붙이려면 `-c 'mcp_servers.<name>.command="node"' -c 'mcp_servers.<name>.args=[...]'` 형태의 TOML 오버라이드가 될 것이다 [inferred; 바이너리에 `mcp_servers.` 키 경로 문자열은 있음]. app-server에서는 `thread/start.config`로 같은 값을 줄 수 있다 [source: config 필드 존재].
- 승인 자동 검토: `--approve-for-me`(자동 리뷰어 경유, workspace-write 샌드박스).

### 3) gemini (0.55.1)

**헤드리스** [help: `gemini --help`; source: `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/docs/cli/headless.md`, `cli/cli-reference.md`]
- `gemini -p "<prompt>"`(stdin이 있으면 앞에 붙고 -p가 뒤에 덧붙음), `-o text|json|stream-json`. **입력 포맷 플래그(`--input-format`)는 없다.** stdin은 시작 시 1회만 읽는다 [source: bundle/gemini-LI2WNAGG.js `readStdin()`].
- `stream-json` 이벤트 6종 [source: bundle/chunk-32XQ54AJ.js:358613 `JsonStreamEventType`, 방출 지점 gemini-LI2WNAGG.js:10956-11300]:
  - `init`: `{type, timestamp, session_id, model}`
  - `message`: `{role:"user"|"assistant", content, delta?:true}` (assistant는 델타 조각, 생각 이벤트는 없다)
  - `tool_use`: `{tool_name, tool_id, parameters}`
  - `tool_result`: `{tool_id, status:"success"|"error", output?, error?{type,message}}`
  - `error`: 비치명적 경고/오류
  - `result`: `{status:"success"|"error", error?{type,message}, stats:{total_tokens,input_tokens,output_tokens,cached,input,duration_ms,tool_calls,models{<model>:{...}}}}`
  - 모든 이벤트에 `timestamp`. 종료 코드: 0 성공, 1 일반 오류, 42 입력 오류, 53 턴 한도 초과 [source: headless.md].
- 세션: `-r/--resume latest|<index>|<uuid>` (+ 프롬프트 인자로 후속), `--session-id <uuid>`(새 세션 UUID를 호스트가 지정), `--list-sessions`, `--delete-session`, `--session-file <json>`. 세션은 `~/.gemini/tmp/<project_hash>/chats/`에 **프로젝트(cwd) 단위**로 저장 [source: cli/session-management.md]. 그래서 worktree마다 cwd가 달라지면 세션 목록도 달라진다 [inferred from doc]. 안전하려면 `--resume <uuid>`를 같은 cwd에서 쓴다.
- 승인: `--approval-mode default|auto_edit|yolo|plan`(`-y`는 폐기). **헤드리스에서 `ask_user` 결정은 `deny`로 처리된다** [source: reference/policy-engine.md:117]. 즉 default 모드의 비-읽기 도구는 승인 없이 거부된다. 정책 파일 `--policy <files|dirs>`, `--admin-policy`로 도구별 allow/deny를 줄 수 있고 `interactive:false` 규칙으로 헤드리스 전용 규칙도 가능 [source: policy-engine.md:96-104]. 전역 deny 규칙에 걸린 도구는 모델에게 아예 보이지 않는다.
- 도구/샌드박스: `-s/--sandbox`(docker/podman/sandbox-exec 등, `GEMINI_SANDBOX`), `--allowed-tools`(폐기, 정책 엔진 사용), `--allowed-mcp-server-names`, `--include-directories`, `--skip-trust`(헤드리스에서 폴더 신뢰 확인 건너뜀).
- 모델: `-m/--model` (alias `auto` 등). 작업 폴더 플래그는 없고 프로세스 cwd.
- worktree: `-w/--worktree [name]`은 **settings.json에 `experimental.worktrees:true`가 있어야** 한다. `.gemini/worktrees/<name>`에 만들고 브랜치도 그 이름. 종료 시 자동 삭제하지 않는다 [source: cli/git-worktrees.md, cli-reference.md].
- MCP: `--mcp-config` 같은 플래그 없음. `gemini mcp add/remove/list/enable/disable`(settings.json의 `mcpServers`를 영구 수정). 일회성 주입은 `GEMINI_CLI_SYSTEM_SETTINGS_PATH`(시스템 settings 경로 오버라이드) 또는 `GEMINI_CLI_HOME`(홈 격리)로 설정 파일을 사무실이 만들어 주입 [source: reference/configuration.md:56, 2626; cli/enterprise.md:224-240; inferred 동작].
- 시스템 프롬프트: `GEMINI_SYSTEM_MD=<abs path>` [source: cli/system-prompt.md].

**ACP 모드 `gemini --acp` (JSON-RPC 2.0/stdio, 장기 실행, 승인 응답 가능)** [source: docs/cli/acp-mode.md, bundle/gemini-LI2WNAGG.js:11830, 12604-12634, 14960-14975]
- 메서드: `initialize`(클라이언트가 MCP 서버 정보를 등록 가능), `authenticate`, `session/new`, `session/load`, `session/prompt`, `session/cancel`, `setSessionMode`(승인 수준), `unstable_setSessionModel`. `newSession`/`loadSession`에 `mcpServers[]` 인자 있음 [source: schema, 12205-12238].
- 알림 `session/update`의 `sessionUpdate`: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `session_info_update`, `usage_update`.
- **호스트가 승인에 답한다**: 에이전트가 클라이언트에게 `session/request_permission`을 요청하고(options[{optionId, kind:allow_once|…}], toolCall{title, content, locations, kind}) 클라이언트가 `outcome: selected(optionId) | cancelled`로 응답.
- `loadSession` 지원 여부는 `initialize` 응답의 `agentCapabilities`로 알려진다(실제 값은 실행해야 알 수 있음).

### 4) git worktree [verified by local experiment in a throwaway repo, 이미 삭제함; git 2.45.1]

- 추가 + 새 브랜치: `git worktree add -b <branch> <path> [<start>]` -> `Preparing worktree (new branch ...)`, 기본 시작점은 현재 HEAD. 기존 브랜치는 `git worktree add <path> <branch>`.
- 목록: `git worktree list` / `--porcelain`(경로, HEAD, `branch refs/heads/...`). 브랜치 목록에서 다른 worktree에 체크아웃된 브랜치는 `+`로 표시.
- **메인 체크아웃은 영향 없음**: worktree에서 커밋해도 메인 폴더 파일/상태는 그대로이고 브랜치만 공유 저장소에 생긴다. 메인 `git status`는 깨끗하게 유지됨.
- **같은 브랜치는 두 worktree에 동시에 체크아웃 불가**: `fatal: 'feat/x' is already used by worktree at ...`.
- 제거: `git worktree remove <path>`; 수정/추적 안 된 파일이 있으면 `fatal: ... contains modified or untracked files, use --force`. 커밋 후 깨끗하면 제거됨. 브랜치는 별도로 남는다: `git branch -d`는 병합 안 됐으면 `not fully merged`로 거부, `-D`는 삭제.
- 정리: 폴더만 지운 worktree는 `list`에 `prunable`로 나오고 `git worktree prune -v`가 메타데이터를 제거.
- 병합: `git merge-tree --write-tree <a> <b>`가 트리 해시를 출력(충돌 없을 때; 작업 트리를 건드리지 않고 충돌 사전 검사에 쓸 수 있음), `git merge --no-ff feat/m`으로 메인에 병합 성공 확인. `git worktree lock/unlock`도 존재.

### 5) Orca orchestration 개념 [출처: `orca skills get orchestration` 및 `--reference references/{coordinator-loop,messaging-and-gates,recovery-and-cleanup,low-level-topology}.md`, `orca orchestration <cmd> --help`; 전문은 scratchpad/upgrade/orca-*.txt]

- **Run**: 조정 단위(목표 objective 하나). Task는 Run 안에서 만든다. 코디네이터(리드)는 Run에 묶이고, 여러 Run이 있으면 `--run <id>`로 지정.
- **Task**: 자기완결적 spec(대상, 변경, 제약, 수정 허용 범위, 완료 증거). `--deps <json_array>`로 **DAG**. 상태: `pending, ready, dispatched, completed, failed, blocked`. "깨어날 때마다 `task-list --ready`가 보여 주는 Task를 시작한다."
- **Dispatch/Worker**: Task를 에이전트에게 배정한 시도 하나(`dispatch:<id>`). `worker-start --task|--spec --worktree current|new-child|new-top-level --agent claude|codex|... [--model --effort --keep-open --retry-of]`. 같은 worktree를 공유하면 충돌하므로 동시에 같은 파일을 고치는 워커는 별도 worktree. 터미널 상태(active, reclaimable, retained, release_pending, release_unknown, released)는 Task 상태와 **별개**로 계량(완료된 Task도 터미널을 쥘 수 있음). 끝난 워커는 자동 해제(autoReleaseAt)되며 `keep-open`이면 유지.
- **메시지**: 타입 `status, dispatch, worker_done, merge_ready, escalation, handoff, decision_gate, question, heartbeat`. 주소 `run:<id>`, `dispatch:<id>`, 그룹 `@all/@idle/@codex/@worktree:<id>`(의도적 팬아웃만). `worker_done`은 `--outcome succeeded|failed`, `--files-modified`, `--report-path` 포함, 정확한 Dispatch 신호이며 그룹에 보낼 수 없다.
- **ask/reply**: 워커는 `ask --question [--options csv]`로 코디네이터에게 질문하고 **턴을 끝낸다**(블로킹하지 않음). Orca가 답을 메일로 가져와 워커를 깨운다. 코디네이터는 `reply --id <message_id>`로 답하며, 답이 과업/사용자 지시에서 따라 나오지 않으면 **사용자에게 먼저 묻는다**.
- **follow-up(`send --to dispatch:<id>`)**: 워커가 작업 중이면 현재 턴이 끝날 때 전달, 끝났거나 닫혔으면 후속 Task로 재개되어 `worker_done`으로 다시 보고. 터미널에 직접 타이핑으로 조종하지 않는다.
- **Gate(`gate-create/resolve/list`)**: Task를 막는 의사결정 게이트(질문 + 선택지). 사용자/코디네이터가 `gate-resolve --resolution`으로 풀어야 진행.
- **에스컬레이션**: `worker_done` 없이 멈추면 `escalation`(stopReason)이 코디네이터에 도착 -> `send`로 조종 / 중지 후 재시도 / 사용자 보고.
- **안전/복구 원칙**: 침묵·타임아웃·liveness 불명만으로는 종료를 증명하지 않는다. `worker-stop`(보호된 중지, `stop_unknown` 가능), `worker-abandon`(펜스만, 프로세스 종료를 주장하지 않음), `worker-release`; 실패한 시도는 같은 Task에 `--retry-of`로 재시도; **같은 retry 체인에서 시작 실패 3회면 Dispatch 회로 차단**(Task 실패), 사용자가 명시하지 않으면 우회 금지. 취소 = 워커 중지/포기 후 Task를 `failed --result cancelled`로.
- **멱등성**: 모든 변경 명령에 `--retry-request <id>`(같은 요청 재전송 시 결과를 재생), `request-show`.
- 코디네이터 규칙: 폴링 금지, Orca가 깨운다; 독립 워커는 모두 시작한 뒤 턴 종료; 워커 보고의 증거를 요약하고 모순이 있을 때만 재검증.

---

## Flow

공통 모델: 사무실 서버가 **어댑터 인터페이스**(start, send, answerApproval, interrupt, stop, resume + 정규화된 `OfficeEvent` 방출)를 가지고, CLI별 구현이 아래 수명주기를 맡는다.

### claude (프로세스 상주, stdin으로 다중 턴)
1. start: 위 플래그로 `spawn(cwd=<worktree>)`. stdin에 첫 `user` 메시지를 쓴다 (`--input-format stream-json`은 첫 메시지가 올 때까지 대기 [inferred]).
2. stream: `system/init`(session_id 저장) -> `stream_event`/`assistant`/`user`를 `Normalizer`로 act/say/think/report 이벤트화 -> `result`가 한 턴의 끝.
3. approval: `control_request(can_use_tool)` 수신 -> `ask` 이벤트로 UI에 노출 -> `control_response`로 allow/deny. `control_cancel_request`로 취소 통지.
4. follow-up: 프로세스가 살아 있으면 같은 stdin에 또 `user` 메시지(턴 사이든, 턴 도중이든 큐잉됨 [inferred: 도중 주입 동작은 미확인]).
5. resume: 프로세스가 끝났으면 `--resume <session_id>`로 새 프로세스(사무실이 이미 쓰는 방식). `--fork-session`으로 분기 가능.
6. stop: `interrupt` control_request(턴만 중단) -> `stdin.end()` -> SIGTERM.

### codex 경로 A: `exec --json` (턴당 프로세스)
1. start: `codex exec --json -C <worktree> -s workspace-write -m <model> "<prompt>"` (프롬프트가 길면 `-`로 stdin). 환경에서 `OPENAI_API_KEY` 등 제거 여부는 정책 결정.
2. stream: `thread.started`에서 thread_id 저장 -> `item.started/updated/completed`를 act/say/plan 이벤트로 -> `turn.completed.usage`로 토큰 -> 프로세스 종료.
3. approval: 헤드리스 exec에서는 호스트가 승인에 응답할 채널이 **없다**. 샌드박스 모드가 곧 정책(`read-only`/`workspace-write`), 샌드박스를 벗어나는 명령은 실패로 끝난다 [inferred].
4. follow-up: 새 프로세스 `codex exec resume <thread_id> "<follow-up>" --json`. (`--last`는 cwd 기준 최근 세션이라 병렬 워커에는 쓰지 말고 항상 id를 쓴다.)
5. stop: SIGTERM. 마지막 메시지는 `-o <file>`로도 받을 수 있다.

### codex 경로 B: `app-server` (권장: 승인과 스티어링 필요 시)
1. start: 워커당 `codex app-server --listen stdio://` 하나(또는 공유 데몬 하나에 thread 여러 개) -> `initialize` -> `thread/start{cwd, sandbox, approvalPolicy:"on-request", model, developerInstructions, config:{mcp_servers...}}` -> `turn/start{threadId, input:[...]}`.
2. stream: `item/started|completed`, `item/agentMessage/delta`, `item/commandExecution/outputDelta`, `turn/plan/updated`, `thread/tokenUsage/updated`, `turn/completed`.
3. approval: 서버가 보낸 `item/commandExecution/requestApproval`(JSON-RPC **요청**, id 있음)에 `{decision:"accept"|"acceptForSession"|"decline"|"cancel"}`로 응답. `item/tool/requestUserInput`은 사용자 질문 UI로 연결, `item/tool/call`(dynamic tools)은 호스트 도구로 처리.
4. follow-up: 턴 진행 중 `turn/steer{threadId, expectedTurnId, input}`; 턴이 끝난 뒤는 `turn/start`. 프로세스를 내렸다면 `thread/resume{threadId}`.
5. stop: `turn/interrupt` -> `thread/unsubscribe`/프로세스 종료.

### gemini 경로 A: `-p --output-format stream-json` (턴당 프로세스)
1. start: `gemini -p "<prompt>" -o stream-json --approval-mode <auto_edit|yolo|default> [--session-id <uuid>] [-m model] [--skip-trust]` , cwd=<worktree>. `--session-id`로 세션 id를 미리 알 수 있어 `init`을 기다릴 필요가 없다.
2. stream: `init` -> `message`(user 에코, assistant `delta:true` 조각) -> `tool_use`/`tool_result`(tool_id로 짝) -> `result`(stats). 프로세스 종료.
3. approval: 호스트 응답 불가. `default`에서 쓰기/셸 도구는 거부되므로 **미리** `--approval-mode auto_edit|yolo` 또는 `--policy <file>`로 허용 범위를 정한다 (+ `-s` 샌드박스).
4. follow-up: `gemini -r <session-uuid> -p "<follow-up>" -o stream-json` (같은 cwd에서).
5. stop: SIGTERM(종료 시 `result` 이벤트 없이 끝날 수 있음 [inferred]; 종료 코드 53 = 턴 제한).

### gemini 경로 B: `--acp` (JSON-RPC, 승인 응답 가능)
1. start: `gemini --acp` -> `initialize` -> `session/new{cwd, mcpServers:[office]}` -> `session/prompt`.
2. stream: `session/update` 알림(`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`).
3. approval: 에이전트의 `session/request_permission` 요청에 `{outcome:{outcome:"selected", optionId}}` 또는 `cancelled`로 응답.
4. follow-up: 턴 사이에 `session/prompt` 재전송; `session/cancel`로 중단; 재시작 후 `session/load`(capability 확인 필요).

### worktree 수명주기(서버 책임)
`git worktree add -b office/<task-id> <BUREAU_DIR>/wt/<task-id> <base>` -> 워커 `cwd`로 사용 -> 워커 완료 후 `git -C <wt> status --porcelain`/커밋 여부 확인 -> `git merge-tree --write-tree`로 사전 충돌 검사 -> 병합(`merge --no-ff`) 또는 사용자 확인 -> `git worktree remove` + `git branch -d`(미병합이면 보존) -> 비정상 종료 시 `git worktree prune`.

---

## Files Read

- `/Users/jaemin/project/bureau-des-agents/server/claude.ts` 전체 (현재 claude 인자와 이벤트 파서)
- `claude --help`, `claude mcp --help`, `claude mcp add --help`, `claude --version`
- `codex --help`, `codex exec --help`, `codex exec resume --help`, `codex exec fork/review --help`, `codex queue --help`, `codex mcp --help`, `codex mcp add --help`, `codex app-server --help`, `codex app-server daemon --help`, `codex app-server generate-json-schema [--experimental]`, `codex features list`, `codex --version`
- 생성한 스키마(로컬 출력만): `/private/tmp/claude-501/-Users-jaemin-project-bureau-des-agents/9accd846-6a8b-44bd-85ee-d238aa09b042/scratchpad/upgrade/codex-schema/` (ClientRequest.json, ServerNotification.json, ServerRequest.json, v2/TurnStartParams.json, v2/TurnSteerParams.json, v2/ThreadStartParams.json, v2/ThreadResumeParams.json, CommandExecutionRequestApprovalParams/Response.json, FileChangeRequestApprovalResponse.json, ToolRequestUserInputParams.json, DynamicToolCallParams.json, v2/ThreadTokenUsageUpdatedNotification.json, codex_app_server_protocol.v2.schemas.json) 와 `codex-schema-exp/`(--experimental)
- `strings -a /opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex` 의 이벤트/아이템 타입 토큰 grep
- `gemini --help`, `gemini mcp --help`, `gemini --version`
- `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/docs/cli/{headless,cli-reference,session-management,git-worktrees,acp-mode,model-steering,plan-mode}.md`, `reference/{policy-engine,configuration}.md`(부분), `cli/{enterprise,system-prompt,sandbox}.md`(부분)
- `/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/chunk-32XQ54AJ.js` (JsonStreamEventType 358613, StreamJsonFormatter 378608-378660), `gemini-LI2WNAGG.js` (헤드리스 루프 10640-11300, ACP 스키마/권한 12000-12640, 14940-14975)
- `git worktree add/list/remove/prune`, `git merge-tree --write-tree`, `git merge`를 scratchpad 임시 저장소에서 실행(삭제 완료)
- `/Applications/Orca.app/Contents/Resources/bin/orca skills get orchestration [--reference references/coordinator-loop.md | messaging-and-gates.md | recovery-and-cleanup.md | low-level-topology.md]`, `orca orchestration --help` 및 send/check/reply/ask/task-create/task-update/worker-start/worker-list/gate-create/gate-resolve/dispatch `--help` (저장본: scratchpad/upgrade/orca-*.txt)

---

## Boundaries

서버가 CLI별로 **파싱해야 하는 것**
- claude: stdout stream-json (이미 구현). 추가로 `system/init.session_id`, `result`, `control_request`. 서브에이전트 이벤트는 `parent_tool_use_id`.
- codex exec: stdout JSONL `thread.started|turn.*|item.*|error`. codex app-server: stdout/stdin 줄 단위 JSON-RPC 2.0 (**알림, 응답, 서버가 보낸 요청** 3종을 id로 구분하고, 서버 요청은 반드시 응답).
- gemini: stdout JSONL(6종) 또는 ACP JSON-RPC. gemini는 `tool_use`/`tool_result`를 `tool_id`로 짝지음.
- stderr는 항상 마지막 4KB를 보관(현재 방식 유지). gemini/codex는 stdout에 비JSON 줄(배너, 경고)이 섞일 수 있으므로 JSON.parse 실패 줄을 버리는 현재 방식 유지 [inferred].

서버가 **제공해야 하는 것**
- stdin: claude는 stream-json user/control 메시지, codex app-server/gemini ACP는 JSON-RPC 요청. exec/gemini -p는 stdin을 쓰지 않거나 프롬프트용으로만 사용.
- 환경변수: claude는 `ANTHROPIC_API_KEY/AUTH_TOKEN` 제거(구독 사용, 현재 구현). codex는 `CODEX_HOME`(인증/세션 위치), `OPENAI_API_KEY`는 정책 선택. gemini는 `GEMINI_API_KEY`/OAuth 캐시(`GEMINI_CLI_HOME`로 격리 가능)와 `GEMINI_CLI_SYSTEM_SETTINGS_PATH`, `GEMINI_SYSTEM_MD`. 사무실 마커 `BUREAU_DES_AGENTS=1` 유지.
- cwd: 모든 CLI는 프로세스 cwd = 해당 worktree 경로. codex는 `-C`, claude는 `--add-dir`로 추가 허용 폴더.
- 사무실이 노출하는 **MCP 서버**(리드 Max에게 `start_worker/send_message/ask_user/...` 도구 제공):
  - claude: `--mcp-config '<json 또는 파일>' --strict-mcp-config` -> 가능 [help].
  - codex: `-c mcp_servers.<n>...` 또는 app-server `thread/start.config`, 또는 `dynamicTools`(MCP 없이 호스트 도구 직접 정의) [source: 스키마 / 일부 inferred].
  - gemini: 설정 파일 주입(`GEMINI_CLI_SYSTEM_SETTINGS_PATH`)이나 ACP `session/new.mcpServers`. 플래그만으로는 불가.
  - MCP 도구 호출은 각 CLI의 승인 흐름을 거친다. 사무실 MCP 도구는 사전 허용(claude `--allowedTools mcp__office__*`, codex `approvalPolicy`/execpolicy, gemini 정책 파일)해야 헤드리스에서 막히지 않는다 [inferred].
- 정규화 계층: `act/say/think/report/ask/plan/leave/file` 이벤트(shared/protocol.ts)에 CLI별 이벤트를 매핑. 이벤트 id 규칙: claude는 `tool_use.id`, codex는 `item.id`, gemini는 `tool_id`.

---

## Non-Obvious Things

1. **claude만 하나의 장기 프로세스에 다중 턴 stdin 입력과 승인 응답을 stream-json으로 제공**한다. codex exec와 gemini -p는 stdin을 시작 시 1회만 읽는다. 후속 메시지는 새 프로세스 + resume이다.
2. **codex exec에는 호스트가 승인에 답할 방법이 없다.** 승인 왕복이 필요하면 `codex app-server`(JSON-RPC)가 정답이고, `turn/steer`와 `item/tool/requestUserInput`, `item/tool/call`(호스트 정의 도구)까지 같이 얻는다. 단 `app-server`는 `[experimental]` 표기이며 스키마는 버전 의존(0.167.1 기준). `codex app-server generate-json-schema/generate-ts`를 설치 버전에 맞춰 빌드 시 생성하는 것이 안전.
3. **gemini 헤드리스는 승인을 못 받는다**: `ask_user -> deny`. 기본 모드에서 쓰기/셸이 조용히 거부된다. 반드시 `--approval-mode`/정책 파일로 사전 결정하거나 ACP로 간다. yolo는 샌드박스(`-s`)와 짝지을 것.
4. gemini stream-json에는 **생각(thought) 이벤트가 없고**, 메시지는 `delta:true` 조각이며, `tool_use`와 `tool_result` 사이에 진행 이벤트가 없다. 플랜/Todo 이벤트도 없다(ACP에는 `plan`, `agent_thought_chunk`가 있다). 서브에이전트 구분 필드도 없다.
5. gemini 세션은 **cwd(프로젝트) 해시별로 저장**된다. worktree를 지운 뒤 같은 세션을 다른 cwd에서 resume하면 못 찾을 수 있다 [inferred]. 세션 id를 `--session-id`로 사무실이 정하면 추적이 쉽다. gemini 자체 `--worktree`는 settings 플래그가 필요하고 자동 삭제가 없으며, codex `--worktree`는 "관리형" worktree라 위치/정리 규칙이 불투명하다 -> **worktree는 사무실이 직접 `git worktree`로 만들고 cwd로만 넘기는 편이 이식성이 높다**.
6. codex `exec resume --last`는 cwd 필터가 걸린 "가장 최근" 세션이라 병렬 워커에서 오동작할 수 있다. 항상 thread id를 저장해 쓴다. `--ephemeral`을 쓰면 resume이 불가능하다.
7. codex `exec`의 JSONL은 snake_case(`item.completed`, `command_execution`), app-server는 camelCase(`item/completed`, `commandExecution`)로 **같은 개념이 다른 스키마**다. 두 경로를 둘 다 지원하면 어댑터를 둘 만들어야 한다. exec 경로의 필드 구조는 이번에 검증하지 못했다.
8. codex/gemini의 `mcp add` 계열은 사용자의 영구 설정을 바꾼다. 사무실은 이를 쓰지 말고 일회성 주입(`-c`, `--mcp-config`, 임시 settings 경로)을 써야 사용자 설정을 건드리지 않는다.
9. codex `--worktree`와 `exec`의 `-a` 부재, `codex mcp-server` 부재처럼 **도움말과 문서/기억이 다른 부분**이 있다. 버전 업에 취약하므로 시작 시 `--version`과 `--help`/`generate-json-schema` 프로브로 능력을 감지하는 것이 좋다.
10. Orca의 ask/reply는 **비동기**: 워커가 질문하고 턴을 끝내면 답이 새 입력으로 되돌아온다. claude(stdin) 외의 CLI에서는 이 모델이 자연스럽게 맞는다 (질문 도구 호출 후 턴 종료 -> 답을 `resume`/`turn/start`로 주입). 사무실의 기존 "ask 말풍선 + 승인" UI와 별개 개념이므로 `ask`(질문)과 `approval`(허락)을 이벤트 종류로 분리할 것.
11. git: 브랜치 하나는 worktree 하나에만 체크아웃 가능, 병렬 워커마다 고유 브랜치 필요. worktree 제거는 더러우면 거부되므로 정리 전 상태 확인 필요. `git branch -d`는 미병합 브랜치를 보호해 준다 (워커 결과를 잃지 않는 안전장치로 활용).
12. Orca의 3회 연속 시작 실패 시 회로 차단, `--retry-request` 멱등성, "침묵은 종료의 증거가 아니다" 같은 규칙은 사무실의 워커 감독 로직(타임아웃, 재시도 한도, 중복 시작 방지)에 그대로 빌려 쓸 만하다.

---

## Open Questions

모델 실행 없이는 확인하지 못한 것 (실제 확인하려면 소량의 실행이 필요).
1. **codex exec --json의 정확한 이벤트 필드**(thread.started.thread_id 이름, item의 id/status/command/exit_code/aggregated_output, turn.completed.usage 구조, error 형태). 토큰 이름은 바이너리 문자열로 존재만 확인. [inferred]
2. codex exec에서 승인이 필요한 명령이 만났을 때의 실제 동작(자동 거부? 실패?)과 `-c approval_policy=...`의 효과. [inferred]
3. codex `-c mcp_servers.<name>...` 일회성 주입이 `exec`에서 실제로 동작하는지, `app-server`의 `thread/start.config`가 같은 경로인지, dynamicTools가 stable에서 쓸 수 있는지(현재는 `--experimental` 스키마에서만 `dynamicTools` 필드 확인). [partially source]
4. codex app-server에서 `turn/steer`가 실제로 도구 실행 도중에 반영되는 시점, 한 app-server 프로세스에서 thread 여러 개를 동시에 돌릴 때의 격리/성능. [inferred]
5. claude stream-json에서 **턴 도중 들어온 user 메시지의 처리**(큐잉 vs 즉시 반영), `--replay-user-messages`의 정확한 출력 형식, `--permission-prompt-tool stdio`가 도움말에 없는 이유(숨김 옵션인지). 사무실이 현재 쓰는 `control_request/response` 경로는 [repo]로 확인됨. [inferred]
6. gemini `--acp`의 `initialize` 응답 capabilities(`loadSession`, `session.resume/fork` 지원 여부)와 `mcpServers` 인자의 http/stdio 지원 범위, 그리고 구독(OAuth) 인증이 ACP/헤드리스 모두에서 비대화식으로 통과하는지. [source는 스키마만]
7. gemini `-p`가 시그널 종료 시 `result`를 내는지, stdout에 비JSON 줄이 섞이는지, `--skip-trust` 없이 헤드리스에서 폴더 신뢰 때문에 멈추는지. [inferred]
8. gemini 세션 resume이 cwd 해시에 얼마나 엄격히 묶이는지(worktree 경로 변경 시). [inferred from doc]
9. 각 CLI의 인증 방식이 헤드리스 병렬 프로세스에서 충돌 없이 동작하는지(토큰 갱신 경합, 레이트 리밋 공유, `rate_limit_event` 대응물: codex는 `account/rateLimits/updated`, gemini는 없음). [inferred]
10. Orca 문서의 `worker-start`가 내부적으로 어떻게 에이전트 TUI를 구동하는지(PTY + 프롬프트 주입 + 메일 체크)는 Orca 쪽이 **헤드리스 JSON 모드가 아니라 터미널(TUI) 기반**이라는 점만 확인됐다. 사무실은 구조화 이벤트를 쓰므로 Orca 방식을 그대로 복제하지 말고 개념(Run/Task/DAG/Dispatch/gate/ask-reply/escalation/재시도 회로)만 차용하면 된다.
