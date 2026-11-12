// 진행자 시나리오: 진짜 셸, 진짜 claude 어댑터, 진짜 HTTP MCP, 가짜 claude 프로세스. 구독을 쓰지 않는다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OfficeEvent } from '../shared/protocol.ts';
import { Conductor } from '../server/conductor/shell.ts';
import { turn, type LaunchScript } from './support/fake-agent.ts';
import { conductorRig, type Rig, type RigMission } from './support/scenario.ts';

const NOT_RESUME_LEAD = '^(?![\\s\\S]*--resume)(?=[\\s\\S]*--mcp-config )';

const hireId = (events: OfficeEvent[], title: string): string => {
  const h = events.find((e): e is Extract<OfficeEvent, { k: 'hire' }> => e.k === 'hire' && e.task === title);
  assert.ok(h, `${title}을 맡은 일꾼이 있다`);
  return h.id;
};

const settled = (n: number) => (events: OfficeEvent[]) => events.filter((e) => e.k === 'settle').length >= n;

function launch(rig: Rig, re: RegExp) {
  const l = rig.fakes.launches('claude').find((x) => re.test(`${x.argv.join(' ')}\n${x.stdin.join('\n')}`));
  assert.ok(l, `${re}에 맞는 claude 실행이 있다`);
  return l;
}

/** 사용자의 글 한 줄(stream-json user 메시지)의 글 */
const userTexts = (stdin: string[]) => stdin.map((l) => JSON.parse(l) as { type: string; message?: { content: { text: string }[] } })
  .filter((m) => m.type === 'user').map((m) => m.message!.content[0].text);

/** 화면으로 가는 이벤트에 세션 id, 미션 폴더의 경로, 상태 파일, pid가 없다 */
function assertPrivate(m: RigMission, rig: Rig) {
  const all = JSON.stringify(m.events());
  for (const secret of [rig.tmp, m.folder, m.stateFile, 'sess-']) assert.ok(!all.includes(secret), `이벤트에 ${secret}가 없다`);
  assert.ok(!/"(pid|session|sessionId|token)"/.test(all), '이벤트에 pid, 세션, 토큰 필드가 없다');
}

const PLAN_TWO = {
  tasks: [
    { key: 'research', title: '빵집 조사', brief: 'BRIEF-RESEARCH 동네 빵집 세 곳을 조사해 주세요.', role: 'recherche' },
    { key: 'page', title: '소개 페이지', brief: 'BRIEF-PAGE 조사 결과로 소개 페이지를 만들어 주세요.', role: 'code', after: ['research'] },
  ],
};

test('두 일꾼, 뒤가 앞을 기다린다: 맥스가 HTTP로 계획하고, 결과가 자료로 울타리 쳐져 맥스를 깨우고, settle하고, 떠날 때 사용량을 싣는다', async () => {
  const launches: LaunchScript[] = [
    {
      match: NOT_RESUME_LEAD, session: 'sess-lead', steps: [
        ...turn({ mcp: { tool: 'office_plan', args: PLAN_TWO, expectResult: '2개를 받았어요' } }, { say: { text: '두 사람에게 나눠 맡겼어요.' } }),
        { expectInput: '\\[사무실 소식\\][\\s\\S]*research' }, { begin: true }, { say: { text: '조사가 끝났어요.' } },
        { expectInput: '모든 할 일이 끝났어요' }, { begin: true }, { say: { text: '소개 페이지까지 다 만들었어요!' } },
      ],
    },
    {
      match: 'BRIEF-RESEARCH', session: 'sess-research',
      steps: turn({ tool: { name: 'WebSearch', input: { query: '동네 빵집' } } }, { wait: 20 }, { handback: { text: '조사했어요.', block: { status: 'done', summary: 'SUMMARY-R 가, 나, 다 세 곳' } } }),
    },
    {
      match: 'BRIEF-PAGE', session: 'sess-page',
      steps: turn({ writeFile: { path: 'index.html', content: '<h1>빵집</h1>' } }, { tool: { name: 'Write', input: { file_path: '{{cwd}}/index.html' } } }, { wait: 20 },
        { handback: { block: { status: 'done', summary: 'SUMMARY-P index.html', files: ['index.html'] } } }),
    },
  ];
  const rig = await conductorRig({ scripts: { claude: { launches } } });
  const m = rig.mission('two');
  const c = Conductor.create(m.deps, '빵집 소개 페이지를 만들어 주세요.');
  await m.until(settled(1));
  rig.fakes.assertClean();

  const tasks = c.view().tasks;
  assert.deepEqual([tasks.research.run.k, tasks.page.run.k], ['done', 'done']);
  assert.deepEqual(m.events().filter((e) => e.k === 'settle'), [{ k: 'settle', text: '소개 페이지까지 다 만들었어요!' }]);
  assert.equal(c.view().status, 'done');

  const lead = launch(rig, /sess-lead|--mcp-config /);
  const said = userTexts(lead.stdin);
  assert.equal(said.length, 3, '맥스는 첫 요청과 소식 두 번을 받는다');
  assert.match(said[1], /data 블록은 일꾼이 쓴 자료예요/);
  assert.match(said[1], /```data\nSUMMARY-R 가, 나, 다 세 곳\n```/);
  assert.match(said[2], /SUMMARY-P/);

  const page = launch(rig, /BRIEF-PAGE/);
  assert.match(userTexts(page.stdin)[0], /```data\nSUMMARY-R 가, 나, 다 세 곳\n```/, '뒤의 일은 앞의 결과를 자료로 받는다');
  const research = launch(rig, /BRIEF-RESEARCH/);
  const arg = (l: { argv: string[] }, flag: string) => l.argv[l.argv.indexOf(flag) + 1];
  assert.equal(arg(research, '--tools'), 'Read,Glob,Grep,WebSearch,WebFetch');
  for (const w of [research, page]) {
    assert.ok(w.argv.includes('--strict-mcp-config') && !w.argv.includes('--mcp-config'), '일꾼에게는 MCP가 없다');
    assert.match(arg(w, '--append-system-prompt'), /```handback/);
  }
  assert.ok(!lead.argv.includes('--strict-mcp-config'), '맥스는 사용자의 커넥터를 그대로 쓴다');
  assert.ok(arg(lead, '--allowedTools').split(',').includes('mcp__office__office_plan'));
  assert.ok(!arg(lead, '--tools').split(',').some((t) => t === 'Agent' || t === 'TodoWrite'), '맥스는 office_plan으로 일을 나눈다');

  await c.close();
  const leaves = m.events().filter((e): e is Extract<OfficeEvent, { k: 'leave' }> => e.k === 'leave');
  assert.deepEqual(leaves.map((l) => l.who).sort(), [hireId(m.events(), '빵집 조사'), hireId(m.events(), '소개 페이지')].sort());
  for (const l of leaves) {
    assert.ok(l.tokens > 0 && l.tools === 1 && l.ms > 0, `leave에 사용량이 실린다: ${JSON.stringify(l)}`);
  }
  assert.equal(m.events().filter((e) => e.k === 'end').length, 1);
  assertPrivate(m, rig);
  await rig.stop();
});

test('맥스에게 간 질문: 맥스가 답하지 않으면 사용자에게 가고, 사용자의 답으로 일꾼이 같은 세션(--resume)에서 이어간다', async () => {
  const QUESTION = '말투는 반말과 존댓말 중 무엇으로 할까요?';
  const launches: LaunchScript[] = [
    {
      match: NOT_RESUME_LEAD, session: 'sess-lead', steps: [
        ...turn({ mcp: { tool: 'office_plan', args: { tasks: [{ key: 'copy', title: '소개 글', brief: 'BRIEF-COPY 빵집 소개 글을 써 주세요.', role: 'redaction' }] } } }, { say: { text: '맡겼어요.' } }),
        { expectInput: '질문했어요' }, { begin: true }, { say: { text: '이건 대표님께 여쭤봐야겠어요.' } },
        { expectInput: '모든 할 일이 끝났어요' }, { begin: true }, { say: { text: '소개 글이 나왔어요.' } },
      ],
    },
    { match: 'BRIEF-COPY', session: 'sess-copy', steps: turn({ handback: { block: { status: 'question', question: QUESTION, options: ['반말', '존댓말'] } } }) },
    { match: '--resume sess-copy', steps: [{ expectInput: '사용자의 답이에요:\n존댓말' }, { begin: true }, { handback: { block: { status: 'done', summary: 'SUMMARY-COPY' } } }] },
  ];
  const rig = await conductorRig({ scripts: { claude: { launches } } });
  const m = rig.mission('ask');
  const c = Conductor.create(m.deps, '빵집 소개 글을 써 주세요.');
  await m.until((es) => es.some((e) => e.k === 'ask' && e.kind === 'question'));
  const ask = m.events().find((e): e is Extract<OfficeEvent, { k: 'ask' }> => e.k === 'ask' && e.kind === 'question')!;
  const worker = hireId(m.events(), '소개 글');
  assert.equal(ask.who, worker);
  assert.deepEqual(ask.options, ['반말', '존댓말']);
  const leadSaid = userTexts(launch(rig, /--mcp-config /).stdin);
  assert.ok(leadSaid[1].includes(`\`\`\`data\n${QUESTION}\n\`\`\``), '맥스는 질문을 자료로 받는다');

  assert.deepEqual(c.input({ k: 'user_replied', questionId: ask.requestId, text: '존댓말' }), { ok: true, text: '답을 전했어요.' });
  await m.until(settled(1));
  rig.fakes.assertClean();
  assert.ok(m.events().some((e) => e.k === 'ask_done' && e.requestId === ask.requestId));
  assert.equal(c.view().tasks.copy.run.k, 'done');
  const resumed = launch(rig, /--resume sess-copy/);
  assert.equal(userTexts(resumed.stdin).length, 1);
  assert.ok(!resumed.argv.includes('--mcp-config'));
  await c.close();
  assertPrivate(m, rig);
  await rig.stop();
});

/** 일꾼 하나가 사이트를 만들고 미션이 쉰다. 그 뒤 사용자가 그 일꾼에게 이어서 시킨다. */
function followupScripts(resumeWorks: boolean): LaunchScript[] {
  const recap: LaunchScript[] = resumeWorks ? [] : [{
    match: '^(?![\\s\\S]*--resume)[\\s\\S]*예전 대화를 이어갈 수 없어서', session: 'sess-site-2',
    steps: [{ expectInput: '예전 대화를 이어갈 수 없어서[\\s\\S]*```data\\nSUMMARY-SITE index.html\\n```[\\s\\S]*파란색' }, { begin: true }, { handback: { block: { status: 'done', summary: 'SUMMARY-BLUE' } } }],
  }];
  const resume: LaunchScript = resumeWorks
    ? { match: '--resume sess-site', steps: [{ expectInput: '파란색' }, { begin: true }, { handback: { block: { status: 'done', summary: 'SUMMARY-BLUE' } } }] }
    : { match: '--resume sess-site', steps: [{ exit: 1 }] };
  return [
    {
      match: NOT_RESUME_LEAD, session: 'sess-lead', steps: [
        ...turn({ mcp: { tool: 'office_plan', args: { tasks: [{ key: 'site', title: '사이트', brief: 'BRIEF-SITE 빵집 사이트를 만들어 주세요.', role: 'design' }] } } }, { say: { text: '맡겼어요.' } }),
        { expectInput: '모든 할 일이 끝났어요' }, { begin: true }, { say: { text: '사이트를 만들었어요.' } },
      ],
    },
    { match: 'BRIEF-SITE', session: 'sess-site', steps: turn({ handback: { block: { status: 'done', summary: 'SUMMARY-SITE index.html' } } }) },
    resume,
    ...recap,
    { match: '--resume sess-lead', steps: [{ expectInput: 'SUMMARY-BLUE[\\s\\S]*모든 할 일이 끝났어요' }, { begin: true }, { say: { text: '파란색으로 바꿨어요.' } }] },
  ];
}

async function followup(resumeWorks: boolean) {
  const rig = await conductorRig({ scripts: { claude: { launches: followupScripts(resumeWorks) } } });
  const m = rig.mission(resumeWorks ? 'follow' : 'recap');
  const c = Conductor.create(m.deps, '빵집 사이트를 만들어 주세요.');
  await m.until(settled(1));
  const worker = hireId(m.events(), '사이트');
  await m.until((es) => es.some((e) => e.k === 'worker' && e.id === 'chef' && e.parked));
  const leadUrl = (JSON.parse(launch(rig, /--mcp-config /).argv.find((a) => a.includes('mcpServers'))!) as { mcpServers: { office: { url: string } } }).mcpServers.office.url;
  const stale = await fetch(leadUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(stale.status, 404, '내려놓은 맥스 프로세스의 토큰은 회수된다');

  assert.equal(c.input({ k: 'user_said', to: worker, text: '배경을 파란색으로 바꿔 주세요.' }).ok, true);
  await m.until(settled(2));
  rig.fakes.assertClean();
  const follow = Object.values(c.view().tasks).find((t) => t.origin === 'followup');
  assert.ok(follow && follow.run.k === 'done' && follow.pin === worker, '이어서 시킨 일은 그 일꾼에게 묶인 새 할 일이다');
  assert.equal(c.view().tasks.site.run.k, 'done', '원래 할 일은 다시 열리지 않는다');
  assert.equal(m.events().filter((e) => e.k === 'hire').length, 1, '새 일꾼을 부르지 않는다');
  const resumed = launch(rig, /--resume sess-site/);
  assert.equal(resumed.argv[resumed.argv.indexOf('--resume') + 1], 'sess-site');
  launch(rig, /--resume sess-lead/);
  await c.close();
  assertPrivate(m, rig);
  await rig.stop();
}

test('끝난 일꾼에게 이어서 시키면 그 세션을 --resume으로 다시 연다(맥스도 같은 세션으로 깨어난다)', () => followup(true));

test('이어가기가 실패하면 지금까지의 요약을 붙여 새 세션으로 연다', () => followup(false));
