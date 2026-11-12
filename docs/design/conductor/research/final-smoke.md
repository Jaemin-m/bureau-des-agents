# 최종 스모크: 진짜 서버, 진짜 claude와 codex, 저장소 미션 하나

2026-11-12, claude 2.1.322 / codex-cli 0.167.1, macOS. 다시 돌리려면
`node scripts/record-cli.ts --only claude:office-repo`(비용 경고를 보여 주고 `yes`를 기다린다. 건너뛰려면 `--yes`).
스크립트는 임시 폴더에 커밋 하나짜리 git 저장소(`README.md`, `NOTES.md`)를 만들고, 임시 `BUREAU_DIR`, `BUREAU_WORKTREES`, `BUREAU_RECORD`로
`server/index.ts --dev`를 자식 프로세스로 띄운다. 설정은 맥스와 claude 일꾼 haiku, 권한 auto, codex 일꾼 `gpt-6-luna`다.
`GIT_CONFIG_GLOBAL`은 빈 파일로 돌려서 사용자의 git 이름과 이메일이 커밋에 닿지 않고, 사무실은 자기 신원(`에이전트 사무실`)으로 커밋한다.
`CODEX_BIN`은 진짜 codex를 그대로 부르면서 인자와 cwd를 한 줄씩 남기는 얇은 감싸개를 가리킨다(`BUREAU_RECORD`의 원문 줄에는 argv가 없어서 이렇게 봤다).
사용자의 저장소와 설정은 건드리지 않았다. 결과는 `tests/fixtures/scenarios/real-final-repo.logged.jsonl`(`Logged[]`)과 `real-final-repo.meta.json`(관찰)이다.

요청: "할 일을 정확히 둘만. 첫째 `readme`(claude)는 README.md 끝에 한 줄, 둘째 `notes`(codex, `after: ["readme"]`)는 NOTES.md 끝에 한 줄." 그다음
`say`(`to` = codex 일꾼)로 "NOTES.md 끝에 한 줄 더", 마지막에 `merge`(`taskKey: notes`).

## 본 것

| # | 확인할 것 | 판정 | 증거 |
|---|---|---|---|
| 1 | `repo_check`가 이름과 기준 브랜치를 답한다 | VERIFIED | `meta.repoInfo`: `{ok: true, label: "repo", branch: "main", dirty: false}` |
| 2 | 맥스가 `office_plan`으로 의존 관계가 있는 정확히 두 할 일을 계획한다 | VERIFIED | `meta.planCalls` 1, `meta.tasks`: `readme`(claude), `notes`(codex, after `readme`). `logged`의 `task` 이벤트 |
| 3a | 두 할 일이 끝나고 `settle`이 온다 | VERIFIED | `logged`에서 `settle`이 처음 한 번(이어서 시킨 뒤 한 번 더) |
| 3b | 할 일마다 `bureau/<미션>/<할 일>` 브랜치와 사무실 커밋 | VERIFIED | `task.run.result.branch`가 `bureau/<미션>/readme`, `.../notes`. 로그는 `7c022bd 에이전트 사무실 <office@localhost> readme: ...`, `16a516c ... notes: ...`. 일꾼은 둘 다 스스로 커밋하지 않았다 |
| 3c | codex 브랜치가 claude 브랜치의 후손이다 | VERIFIED | `meta.afterSettle.codexDescendsFromClaude` true. `codexLog`가 `16a516c`, `7c022bd`. codex 브랜치의 README.md는 `hello\nclaude was here` |
| 3d | 사용자 체크아웃의 HEAD와 `status --porcelain`이 그대로다 | VERIFIED | `afterSettle.headSame`, `statusSame` true, 루트의 README.md는 `hello`, NOTES.md는 `notes`. 이어서 시킨 뒤에도 같다(`followup.rootHeadSame`, `rootStatusSame`). 합치기 전까지 아무도 루트에서 일하지 않았다 |
| 4a | 이어서 시키기가 `exec resume`으로 돌았다 | VERIFIED | 감싸개 기록 `meta.codexExecCalls`: 첫 턴 `exec --json --ignore-user-config --skip-git-repo-check -C <worktree> -s workspace-write -m gpt-6-luna -`, 이어서는 `exec resume 01a1ce77-… --json --ignore-user-config --skip-git-repo-check -c sandbox_mode="workspace-write" -m gpt-6-luna -`. 원문 줄의 `thread.started`가 두 세션 모두 같은 thread id(`meta.codexThreadIds`) |
| 4b | 새 줄이 그 일꾼의 worktree에 떨어졌다(루트도 미션 폴더도 아니다) | VERIFIED | `followup.notesInWorktree` = `notes\ncodex was here\ncodex again\n`, `followup.notesInRoot` = `notes\n`, `followup.notesInMissionFolder` = null |
| 4c | 사무실이 같은 브랜치에 보관했다 | VERIFIED | `followup.codexLogAfter`: `e24e701 에이전트 사무실 ... f.11: 이어서: ...` 위에 `16a516c`, `7c022bd`. `notesOnBranch` = `notes\ncodex was here\ncodex again`. worktree의 `status`는 비어 있다 |
| 5 | `merge`: 기준 브랜치가 병합 커밋으로 나아가고 작업 트리가 깨끗하다 | VERIFIED | `meta.merge`: `main`이 `e37a08b`에서 `b17ca97`로, 부모 2개, `b17ca97 에이전트 사무실 <office@localhost> Merge branch 'bureau/<미션>/notes'`, `statusAfter` 빈 글, 체크아웃은 `main`, README.md `hello\nclaude was here`, NOTES.md `notes\ncodex was here\ncodex again`. `logged`에서 `notes`와 `f.11` 모두 `merged: true` |

## codex `exec resume`의 cwd

`exec resume`에는 `-C`와 `-s`가 없다(`server/agents/codex.ts`). 폴더는 프로세스의 cwd가 정한다. 진짜 codex를 감싼 기록에서 resume 호출의 cwd는
그 일꾼의 worktree(`<WORKTREES>/<미션>/notes`)였고, 첫 턴의 `-C`와 같은 폴더다. 새 줄은 그 worktree의 NOTES.md에 들어갔다. 같은 thread id로 이어졌고
샌드박스는 `-c sandbox_mode="workspace-write"`로 다시 정해서 읽기 전용으로 떨어지지 않았다. U7에서 열어 두었던 물음은 닫혔다.

## 찾은 것과 고친 것

첫 실행(5개 확인은 모두 통과)에서 이어서 시키기가 만든 할 일 `f.N`에 두 가지가 어긋났다.

1. 맥스가 소식("`f.11`을 마쳤어요")을 받고 "제가 만들지 않은 할 일이 하나 더 끝났어요"라고 마무리했다. 사용자가 시킨 일이라는 말이 소식에 없었다.
   소식 문장이 이제 "사용자가 이어서 시킨 일 'f.11'를 마쳤어요"(실패도 같다)로 나간다(`server/conductor/step.ts`의 `taskPhrase`).
2. 원래 할 일 `notes`를 합쳐도 같은 브랜치의 `f.11`은 합치지 않은 것으로 남았다(버리기도 같다). 합치기와 버리기가 같은 일꾼의 끝난 할 일 모두에 표시를 붙인다(`server/conductor/shell.ts`의 `sameBranch`).

`tests/final-followup-branch.test.ts`(가짜 CLI, 진짜 서버와 git)가 고치기 전에는 둘 다 실패하는 것을 확인했다. 첫째는 맥스의 깨우는 글 검사가, 둘째는 `f.N`의 `merged`가 안 오는 것으로.
진짜 실행을 한 번 더 돌렸고(이 문서의 표가 그 실행이다), 맥스의 마무리 글이 "이어서 리누스가 NOTES.md 맨 끝에 \"codex again\"도 추가했어요"로 나왔고 `notes`와 `f.11`이 함께 `merged: true`가 됐다.
첫 실행의 기록은 지웠다.

남은 관찰(고치지 않았다): `notes` 카드의 `result.head`는 이어서 시키기 전의 커밋(`16a516c`)에 머문다. 새 끝(`e24e701`)은 `f.N`의 결과가 싣는다. 합치기는 브랜치 끝을 합치므로 내용은 맞다.

## 모델 호출(대략)

실행 한 번에 7번: 맥스(claude haiku) 턴 4번(계획, 깨움 2번, 이어서 시킨 뒤 깸), claude 일꾼 턴 1번, codex 턴 2번(첫 턴과 `exec resume`). 고치기 전과 후 두 번 돌아서 모두 약 14번이다. 한 실행은 약 50초(`meta.ms` 47413)다.

## 지우기

`record-cli.ts`의 `makeScrub`로 지웠다: 미션 폴더(`/work/mission`), worktree 뿌리(`<WORKTREES>`), 저장소(`<REPO>`), 임시 폴더, 홈 폴더, 사용자 이름, git 이름과 이메일, 토큰 모양, 포트.
지운 뒤 커밋할 파일(두 픽스처, 두 테스트, 이 문서)에서 홈 경로, 사용자 이름, 깃 이름, 이메일 값, 시스템 임시 폴더와 사용자 폴더의 경로 머리, 토큰 모양(API 키, 베어러, JWT, 깃허브 토큰),
이메일 모양, 맥스 MCP 주소의 토큰 경로, 녹화 스크립트의 임시 폴더 이름으로 grep했고 모두 0건이다. 지우기 전의 기록에도 임시 폴더와 홈 경로는 없었다(`meta.pathsInLog` 0).
임시 폴더, 서버, 자식 프로세스는 실행이 끝날 때 정리했다.
