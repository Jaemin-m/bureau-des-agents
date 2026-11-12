// 사무실 처음부터 끝까지: 진짜 서버(server/index.ts)와 진짜 화면을 가짜 에이전트(구독 사용량 0)로 돌리고, 헤드리스 Chrome(CDP)으로 화면을 직접 조작한다.
//   node scripts/e2e-office.ts                 클라이언트를 빌드하고 돌린다
//   node scripts/e2e-office.ts --no-build      dist/가 이미 최신이면 빌드를 건너뛴다
//   node scripts/e2e-office.ts --shots <폴더>  스크린샷을 둘 곳(기본: 임시 폴더)
//   node scripts/e2e-office.ts --only repo     한 부분만(office, lead, repo)
// 한 걸음마다 무엇을 하는지 출력하고, 어긋나면 이유를 출력하고 0이 아닌 코드로 끝난다. CI 테스트가 아니다(Chrome이 필요하다).
// Chrome 위치는 CHROME_BIN으로 바꿀 수 있다.
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeAgents, turn, type FakeAgents, type LaunchScript, type Step } from '../tests/support/fake-agent.ts';
import { freePort } from '../tests/support/office-process.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const SHOTS = path.resolve(flag('--shots') ?? mkdtempSync(path.join(os.tmpdir(), 'bureau-e2e-shots-')));

// ── 가짜 에이전트의 대본 ──

const QUESTION = '소개 글의 말투는 무엇으로 할까요?';
const ANSWER = '정중한 존댓말로 써 주세요 7391';
const FOLLOW_B = 'FOLLOWUP-B 제목을 더 짧게 줄여 주세요.';
const FOLLOW_C = 'FOLLOWUP-C 끝에 한 줄을 덧붙여 주세요.';
const CODEX_MODEL = 'fake-codex-mini';
const FOLLOW_CX = 'FOLLOWUP-CX 파일 이름을 바꿔 주세요.';

const PLAN = {
  tasks: [
    { key: 'writer', title: '소개 글 쓰기', brief: 'BRIEF-WRITER 빵집 소개 글을 써 주세요.', role: 'redaction', agent: 'claude' },
    { key: 'coder', title: '소개 글을 페이지로', brief: 'BRIEF-CODER 소개 글로 페이지를 만들어 주세요.', role: 'code', agent: 'codex', after: ['writer'] },
  ],
};

const done = (summary: string) => ({ handback: { block: { status: 'done', summary } } }) as Step;
/** 입력이 뭐든 받아서 한 턴을 마친다(맥스는 소식이 올 때마다 깬다. 몇 번 깨는지는 소식을 모으는 시간에 달렸다) */
const anyTurn = (n: number): Step[] => Array.from({ length: n }, (_, i) => [{ expectInput: '.' }, { begin: true }, { say: { text: `맥스의 말 ${i + 1}` } }] as Step[]).flat();

type Scripts = { claude: { launches: LaunchScript[] }; codex: { launches: LaunchScript[] } };

function scripts(): Scripts {
  const claude: LaunchScript[] = [
    {
      match: '^(?![\\s\\S]*--resume)(?=[\\s\\S]*--mcp-config )', session: 'sess-lead',
      steps: [...turn({ mcp: { tool: 'office_plan', args: PLAN, expectResult: '2개를 받았어요' } }, { say: { text: '두 사람에게 나눠 맡겼어요.' } }), ...anyTurn(6)],
    },
    ...Array.from({ length: 6 }, (): LaunchScript => ({ match: '--resume sess-lead', steps: anyTurn(6) })),
    {
      match: 'BRIEF-WRITER', session: 'sess-writer',
      steps: turn({ handback: { text: '질문이 있어요.', block: { status: 'question', question: QUESTION, options: ['반말', '존댓말'], audience: 'user' } } }),
    },
    // 같은 세션을 이어 여는 순서: 질문의 답, 끝난 뒤 이어서 시킨 말, 멈췄다가 이어서 하기
    { match: '--resume sess-writer', steps: [{ expectInput: `사용자의 답이에요:\\n${ANSWER}` }, { begin: true }, done('SUMMARY-WRITER 소개 글 완성')] },
    { match: '--resume sess-writer', steps: [{ expectInput: 'FOLLOWUP-B' }, { begin: true }, done('SUMMARY-FOLLOW-B 제목을 줄였어요')] },
    { match: '--resume sess-writer', steps: [{ expectInput: 'FOLLOWUP-C' }, { begin: true }, { interrupt: { partial: '덧붙이는 중…' } }] },
    { match: '--resume sess-writer', steps: [{ expectInput: '.' }, { begin: true }, done('SUMMARY-FOLLOW-C 한 줄을 덧붙였어요')] },
  ];
  const codex: LaunchScript[] = [
    {
      match: 'BRIEF-CODER', thread: 'thr-coder',
      steps: turn({ writeFile: { path: 'page.html', content: '<h1>빵집</h1>\n' } }, { command: { run: "/bin/sh -c 'echo page'" } }, done('SUMMARY-CODER page.html')),
    },
    { match: 'resume thr-coder', steps: turn({ hang: true }) },
    { match: 'resume thr-coder', steps: turn(done('SUMMARY-FOLLOW-CX 이름을 바꿨어요')) },
  ];
  return { claude: { launches: claude }, codex: { launches: codex } };
}

// ── Chrome(CDP) ──

type Json = Record<string, any>;

const CHROME = [process.env.CHROME_BIN, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  .find((p): p is string => !!p && existsSync(p));

class Cdp {
  private ws: WebSocket;
  private id = 0;
  private pending = new Map<number, { resolve(v: Json): void; reject(e: Error): void }>();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as Json;
      const p = m.id !== undefined ? this.pending.get(m.id) : undefined;
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${m.error.message}`)); else p.resolve(m.result ?? {});
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { ws.addEventListener('open', () => resolve()); ws.addEventListener('error', () => reject(new Error('CDP에 연결하지 못했어요'))); });
    return new Cdp(ws);
  }

  send(method: string, params: Json = {}): Promise<Json> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  close() { this.ws.close(); }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

class Page {
  private cdp: Cdp;
  private n = 0;
  private prefix: string;
  constructor(cdp: Cdp, prefix: string) { this.cdp = cdp; this.prefix = prefix; }

  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`화면 스크립트 오류: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}\n${expression.slice(0, 200)}`);
    return r.result.value as T;
  }

  /** 식이 참이 될 때까지 기다린다. 시간이 다 되면 마지막 값을 담아 던진다 */
  async waitFor(what: string, expression: string, ms = 20_000): Promise<void> {
    const end = Date.now() + ms;
    let last: unknown;
    while (Date.now() < end) {
      try { last = await this.eval(expression); if (last) return; } catch (e) { last = e instanceof Error ? e.message : e; }
      await sleep(100);
    }
    await this.shot(`실패-${what.replace(/[^\w가-힣]+/g, '-').slice(0, 40)}`).catch(() => {});
    throw new Error(`${ms}ms 안에 “${what}”이 되지 않았어요(마지막 값: ${JSON.stringify(last)})`);
  }

  store<T>(select: string): Promise<T> {
    return this.eval<T>(`(() => { const s = window.__bureau.useOffice.getState(); return (${select})(s); })()`);
  }

  /** 마우스로 누른다. selector에 맞는 것 중 글(text)이 들어 있는 첫 요소의 가운데를 누른다 */
  async click(selector: string, text = ''): Promise<void> {
    const rect = await this.eval<{ x: number; y: number } | null>(`(() => {
      const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => (e.textContent ?? '').includes(${JSON.stringify(text)}) && !e.disabled && e.getClientRects().length);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    assert.ok(rect, `누를 것이 없어요: ${selector} “${text}”`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.cdp.send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
    }
  }

  /** 입력칸을 눌러 포커스를 주고 글을 넣는다(키보드 입력과 같은 경로) */
  async type(selector: string, text: string): Promise<void> {
    await this.click(selector);
    await this.cdp.send('Input.insertText', { text });
  }

  async enter(): Promise<void> {
    for (const type of ['keyDown', 'keyUp']) {
      await this.cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, ...(type === 'keyDown' ? { text: '\r' } : {}) });
    }
  }

  async shot(name: string): Promise<string> {
    await sleep(450);
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(SHOTS, `${this.prefix}${String(++this.n).padStart(2, '0')}-${name}.png`);
    writeFileSync(file, Buffer.from(data as string, 'base64'));
    console.log(`     스크린샷: ${file}`);
    return file;
  }
}

// ── 진행 ──

let stepNo = 0;
const step = (text: string) => console.log(`${String(++stepNo).padStart(2, '0')}. ${text}`);
const ok = (text: string) => console.log(`     ✓ ${text}`);

const children: ChildProcess[] = [];
const cleanups: (() => void)[] = [];
function cleanup() {
  for (const c of children) if (c.exitCode === null) { try { c.kill('SIGKILL'); } catch { /* 이미 끝났다 */ } }
  for (const f of cleanups) { try { f(); } catch { /* 지우지 못해도 넘어간다 */ } }
}
process.on('exit', cleanup);

function launches(fakes: FakeAgents, kind: 'claude' | 'codex') { return fakes.launches(kind); }
const userText = (stdin: string[]) => stdin.flatMap((l) => { try { const m = JSON.parse(l); return m.type === 'user' ? [String(m.message?.content?.[0]?.text ?? '')] : []; } catch { return [l]; } });

async function until(what: string, pred: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return; await sleep(100); }
  throw new Error(`${ms}ms 안에 “${what}”이 되지 않았어요`);
}

interface Office { fakes: FakeAgents; page: Page; serverOut(): string; stop(): void }

/** 가짜 에이전트, 진짜 서버, 헤드리스 Chrome을 띄우고 사무실을 연다. 스크린샷 이름 앞에 prefix가 붙는다. */
async function openOffice(scriptSet: Scripts, prefix: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<Office> {
  step('가짜 claude와 codex를 깔고, 진짜 서버를 빈 포트에 띄워요');
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bureau-e2e-')));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const fakes = fakeAgents(scriptSet);
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), BUREAU_DIR: path.join(tmp, 'office'), CLAUDE_BIN: fakes.bin.claude, CODEX_BIN: fakes.bin.codex, ...extraEnv };
  delete env.BUREAU_RECORD;
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(server);
  let serverOut = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`서버가 뜨지 않았어요:\n${serverOut}`)), 15_000);
    const onData = (d: Buffer) => { serverOut += d.toString('utf8'); if (serverOut.includes('⏹')) { clearTimeout(timer); resolve(); } };
    server.stdout!.on('data', onData);
    server.stderr!.on('data', onData);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`서버가 끝났어요(코드 ${code}):\n${serverOut}`)); });
  });
  ok(`서버 http://localhost:${port}, 사무실 폴더 ${tmp}`);

  step('헤드리스 Chrome을 띄우고 사무실을 열어요');
  const debugPort = await freePort();
  const chrome = spawn(CHROME!, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--mute-audio', '--window-size=1280,860',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(tmp, 'chrome')}`, 'about:blank',
  ], { stdio: 'ignore' });
  children.push(chrome);
  const targets = await (async () => {
    for (let i = 0; i < 100; i++) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as Json[];
        const page = list.find((t) => t.type === 'page');
        if (page) return page;
      } catch { /* 아직 안 떴다 */ }
      await sleep(100);
    }
    throw new Error('Chrome의 디버그 포트에 연결하지 못했어요');
  })();
  const cdp = await Cdp.connect(targets.webSocketDebuggerUrl as string);
  const page = new Page(cdp, prefix);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `http://localhost:${port}/` });
  await page.waitFor('서버에 연결', `window.__bureau?.useOffice.getState().connection === 'live'`, 20_000);
  await page.waitFor('맥스의 입력창', `!!document.querySelector('.composer textarea')`);
  ok('화면이 서버와 연결됐어요');
  await page.shot('시작-빈사무실');
  return { fakes, page, serverOut: () => serverOut, stop: () => { cdp.close(); for (const c of [chrome, server]) if (c.exitCode === null) c.kill('SIGKILL'); } };
}

function prepare() {
  assert.ok(CHROME, 'Chrome을 찾을 수 없어요. CHROME_BIN에 실행 파일 경로를 알려 주세요.');
  mkdirSync(SHOTS, { recursive: true });
  console.log(`스크린샷 폴더: ${SHOTS}`);
  if (!argv.includes('--no-build')) {
    step('클라이언트를 빌드해요(vite build)');
    execFileSync('npx', ['vite', 'build', '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
  }
}

async function main() {
  const { fakes, page, serverOut, stop } = await openOffice(scripts(), 'a');

  step('설정 창에서 Codex 모델을 적어요(codex가 깔려 있을 때만 보이는 칸)');
  await page.click('.icon-btn[title="설정"]');
  await page.waitFor('Codex 모델 칸', `[...document.querySelectorAll('.modal.settings .field > span')].some((e) => e.textContent === 'Codex 일꾼의 두뇌')`);
  await page.type('.modal.settings .field input[type=text]', CODEX_MODEL);
  await page.enter();
  await page.waitFor('설정 저장', `window.__bureau.useOffice.getState().settings.codexModel === ${JSON.stringify(CODEX_MODEL)}`);
  await page.shot('설정-codex모델');
  await page.click('.modal.settings .close');
  await page.waitFor('설정 창 닫힘', `!document.querySelector('.modal.settings')`);
  ok(`서버가 받은 설정: codexModel = ${CODEX_MODEL}`);

  step('입력창에 미션을 적고 “시작”을 눌러요');
  await page.type('.composer textarea', '빵집 소개 글을 쓰고 페이지로 만들어 주세요.');
  await page.click('.composer .btn.send', '시작');
  await page.waitFor('미션 시작', `window.__bureau.useOffice.getState().mission?.status === 'working'`);
  await page.waitFor('일꾼 한 명이 올 때까지', `Object.keys(window.__bureau.useOffice.getState().agents).length >= 1`);
  ok('미션이 시작됐고 맥스가 계획해서 일꾼을 불렀어요');
  await page.shot('미션시작-일꾼호출');

  step('맥스의 claude는 읽기 전용이에요(도구 목록을 실행 옵션에서 확인)');
  const leadLaunch = launches(fakes, 'claude').find((l) => l.argv.includes('--mcp-config'))!;
  const leadArg = (f: string) => leadLaunch.argv[leadLaunch.argv.indexOf(f) + 1];
  assert.equal(leadArg('--tools'), 'Read,Glob,Grep');
  assert.ok(!leadLaunch.argv.includes('--strict-mcp-config'), '맥스는 사용자의 커넥터를 그대로 쓴다');
  ok(`맥스의 --tools ${leadArg('--tools')}`);

  step('일꾼의 질문이 화면 아래 질문 카드로 떠요');
  await page.waitFor('질문 카드', `!!document.querySelector('.askbar .ask-card.question')`);
  const cardText = await page.eval<string>(`document.querySelector('.askbar .ask-card.question').textContent`);
  assert.ok(cardText.includes(QUESTION), `카드에 질문이 있어야 해요: ${cardText}`);
  assert.equal(launches(fakes, 'codex').length, 0, '질문에 답하기 전에는 codex 일꾼이 시작하지 않는다');
  ok(`질문 카드: ${QUESTION}, codex 일꾼은 아직 시작하지 않았어요`);
  await page.shot('질문카드');

  step('질문 카드에 답을 적고 “답하기”를 눌러요');
  await page.type('.askbar .ask-card.question .ask-reply input', ANSWER);
  await page.click('.askbar .ask-card.question .btn', '답하기');
  await page.waitFor('질문 카드가 닫힘', `!document.querySelector('.askbar .ask-card.question')`);
  await until('질문의 답을 받은 이어 열기', () => launches(fakes, 'claude').some((l) => l.argv.includes('--resume') && userText(l.stdin).some((t) => t.includes(ANSWER))));
  const answered = launches(fakes, 'claude').find((l) => l.argv.includes('--resume') && l.argv[l.argv.indexOf('--resume') + 1] === 'sess-writer')!;
  assert.deepEqual(userText(answered.stdin), [`사용자의 답이에요:\n${ANSWER}`], '일꾼은 같은 세션에서 답의 글을 그대로 받았다');
  ok(`가짜 일꾼이 --resume sess-writer에서 받은 글: “${userText(answered.stdin)[0].replace('\n', ' ')}”`);

  step('답 뒤에 codex 일꾼이 이어서 일해요');
  await page.waitFor('코드 할 일 끝', `window.__bureau.useOffice.getState().tasks.coder?.run.k === 'done'`, 30_000);
  const codexFirst = launches(fakes, 'codex')[0];
  assert.match(codexFirst.stdin[0], /SUMMARY-WRITER 소개 글 완성/, 'codex 일꾼은 앞의 결과를 자료로 받는다');
  assert.equal(codexFirst.argv[codexFirst.argv.indexOf('-m') + 1], CODEX_MODEL, 'codex 일꾼은 설정 창에서 적은 모델로 돈다');
  ok('codex 일꾼이 앞 일꾼의 결과를 받고 끝냈어요');
  await page.waitFor('미션이 쉼', `window.__bureau.useOffice.getState().settled !== null`, 30_000);
  ok('모든 일이 끝나 미션이 쉬어요');
  await page.shot('모두끝남');

  const agentName = (task: string) => page.store<string>(`(s) => Object.values(s.agents).find((a) => a.task === ${JSON.stringify(task)}).name`);
  const agentId = (task: string) => page.store<string>(`(s) => Object.values(s.agents).find((a) => a.task === ${JSON.stringify(task)}).id`);
  const phaseOf = (id: string) => page.store<string>(`(s) => s.agents[${JSON.stringify(id)}]?.phase`);
  const writer = { id: await agentId('소개 글 쓰기'), name: await agentName('소개 글 쓰기') };
  const coder = { id: await agentId('소개 글을 페이지로'), name: await agentName('소개 글을 페이지로') };

  /** 팀 창에서 일꾼 카드를 연다(실제 사용자가 가는 길) */
  const openCard = async (who: { id: string; name: string }) => {
    await page.click('.icon-btn[title^="팀 전체"]');
    await page.click('.modal .who-row', who.name);
    await page.waitFor(`${who.name} 카드`, `!!document.querySelector('.worker-talk textarea')`);
  };
  const closeModal = async () => {
    await page.click('.modal .close');
    await page.waitFor('창 닫힘', `!document.querySelector('.modal-back')`);
  };
  const settledAt = () => page.store<number>(`(s) => s.settled?.at ?? 0`);

  step(`끝난 일꾼 ${writer.name}의 카드에서 이어서 시켜요`);
  const before = await settledAt();
  await openCard(writer);
  await page.shot('일꾼카드-끝난일꾼');
  await page.type('.worker-talk textarea', FOLLOW_B);
  await page.enter();
  await until('이어서 시킨 말을 받은 이어 열기', () => launches(fakes, 'claude').some((l) => userText(l.stdin).some((t) => t.includes('FOLLOWUP-B'))));
  const followed = launches(fakes, 'claude').find((l) => userText(l.stdin).some((t) => t.includes('FOLLOWUP-B')))!;
  assert.equal(followed.argv[followed.argv.indexOf('--resume') + 1], 'sess-writer', '이어서 시킨 말은 같은 세션을 다시 열어 받는다');
  assert.equal(Object.keys(await page.store<object>(`(s) => s.agents`)).length, 2, '새 일꾼을 부르지 않는다');
  await page.waitFor('이어서 시킨 일이 끝나고 다시 쉼', `(window.__bureau.useOffice.getState().settled?.at ?? 0) > ${before}`, 30_000);
  ok(`${writer.name}가 --resume으로 이어서 일하고 끝냈어요(새 일꾼 없음)`);
  await page.waitFor('카드에 대화', `document.querySelector('.thread, .worker-talk')?.closest('section')?.textContent.includes('FOLLOWUP-B')`);
  await page.shot('일꾼카드-이어서시킴');
  await closeModal();

  step(`${writer.name}와 ${coder.name}에게 각각 이어서 시켜서 둘 다 일하게 해요(둘 다 끝나지 않고 기다려요)`);
  await openCard(writer);
  await page.type('.worker-talk textarea', FOLLOW_C);
  await page.enter();
  await page.waitFor(`${writer.name} 일하는 중`, `window.__bureau.useOffice.getState().agents[${JSON.stringify(writer.id)}].phase === 'working'`);
  await closeModal();
  await openCard(coder);
  await page.type('.worker-talk textarea', FOLLOW_CX);
  await page.enter();
  await page.waitFor(`${coder.name} 일하는 중`, `window.__bureau.useOffice.getState().agents[${JSON.stringify(coder.id)}].phase === 'working'`);
  await closeModal();
  assert.equal(await phaseOf(writer.id), 'working');
  assert.equal(await phaseOf(coder.id), 'working');
  await page.shot('둘다-일하는중');
  ok('둘 다 working이에요');

  step(`${writer.name}의 카드에서 “${writer.name}만 멈추기”를 눌러요`);
  await openCard(writer);
  await page.click('.worker-talk-actions .btn.stop', `${writer.name}만 멈추기`);
  await page.waitFor(`${writer.name} 멈춤`, `window.__bureau.useOffice.getState().agents[${JSON.stringify(writer.id)}].phase === 'stopped'`);
  await sleep(1500);
  assert.equal(await phaseOf(writer.id), 'stopped');
  assert.equal(await phaseOf(coder.id), 'working', `${coder.name}는 계속 일한다`);
  assert.equal(await page.store<string>(`(s) => s.mission.status`), 'working', '미션은 계속 진행 중이다');
  assert.equal(await page.eval<string>(`document.querySelector('.agent-hero .pill-status').textContent`), '멈췄어요', '카드가 멈췄다고 말한다');
  await page.shot('일꾼카드-하나만멈춤');
  ok(`${writer.name}만 stopped, ${coder.name}는 working, 미션은 working`);
  await closeModal();

  step('“멈추기”로 미션 전체를 멈추고 “이어서 하기”가 뜨는지 봐요');
  await page.click('.composer .btn.stop', '멈추기');
  await page.waitFor('미션 멈춤', `window.__bureau.useOffice.getState().mission.status === 'stopped'`);
  await page.waitFor('이어서 하기 버튼', `!!document.querySelector('.composer .btn.resume')`, 10_000);
  assert.equal(await phaseOf(coder.id), 'stopped', `${coder.name}도 멈췄다`);
  ok('미션이 stopped이고 “▶ 이어서 하기” 버튼이 보여요');
  await page.shot('미션멈춤-이어서하기');

  step('“이어서 하기”를 눌러요: 멈췄던 두 일꾼이 이어서 일하고 미션이 끝나요');
  const settledBefore = await settledAt();
  await page.click('.composer .btn.resume', '이어서 하기');
  await page.waitFor('미션이 다시 진행', `window.__bureau.useOffice.getState().mission.status === 'working'`, 10_000);
  await page.waitFor('이어서 한 일이 모두 끝나 다시 쉼', `(window.__bureau.useOffice.getState().settled?.at ?? 0) > ${settledBefore}`, 40_000);
  const tasks = await page.store<Record<string, { run: { k: string } }>>(`(s) => s.tasks`);
  assert.ok(Object.values(tasks).every((t) => t.run.k === 'done'), `모든 할 일이 끝났다: ${JSON.stringify(Object.entries(tasks).map(([k, t]) => [k, t.run.k]))}`);
  assert.equal(await page.store<string>(`(s) => s.mission.status`), 'done');
  ok(`할 일 ${Object.keys(tasks).length}개가 모두 done, 미션 done`);
  await page.shot('이어서하기-끝남');

  fakes.assertClean();
  ok('가짜 에이전트의 대본이 어긋난 곳이 없어요');
  assert.ok(!serverOut().includes('Error'), `서버 출력에 오류가 있어요:\n${serverOut()}`);
  stop();
}

/** 맥스가 시작할 때마다 죽는 미션: 세 번 만에 오류로 서고, 이유가 대화창에 남고, “이어서 하기”가 같은 요청부터 다시 시도한다 */
async function leadFailure() {
  const crash = (): LaunchScript => ({ steps: [{ crash: true }] });
  const { fakes, page, serverOut, stop } = await openOffice({
    claude: { launches: [crash(), crash(), crash(), { steps: [{ expectInput: '빵집 소개' }, { begin: true }, { say: { text: '이번에는 시작했어요.' } }] }] },
    codex: { launches: [] },
  }, 'b');

  step('맥스가 시작하지 못하는 미션을 시작해요: 세 번 만에 오류로 서고 이유가 보여요');
  await page.type('.composer textarea', '빵집 소개 글을 써 주세요.');
  await page.click('.composer .btn.send', '시작');
  await page.waitFor('미션 오류', `window.__bureau.useOffice.getState().mission?.status === 'error'`);
  await page.waitFor('대화창의 이유', `document.querySelector('.dialog-text').textContent.includes('눌러 주세요')`);
  const said = await page.eval<string>(`document.querySelector('.dialog-text').textContent`);
  assert.match(said, /맥스를 시작하지 못했어요/);
  await page.waitFor('이어서 하기 버튼', `!!document.querySelector('.composer .btn.resume')`, 10_000);
  assert.equal(launches(fakes, 'claude').length, 3, '네 번째 시도는 없다');
  assert.equal(await page.eval<string>(`document.querySelector('.topbar .dot').className`), 'dot error', '상단 표시등이 오류다');
  ok(`대화창: “${said.trim()}”`);
  await page.shot('맥스-시작-실패');

  step('“이어서 하기”를 눌러요: 같은 요청부터 다시 시도하고 미션이 끝나요');
  await page.click('.composer .btn.resume', '이어서 하기');
  await page.waitFor('미션 끝', `window.__bureau.useOffice.getState().mission.status === 'done'`, 20_000);
  assert.equal(launches(fakes, 'claude').length, 4);
  assert.ok(userText(launches(fakes, 'claude')[3].stdin)[0].includes('빵집 소개 글을 써 주세요.'), '실패했던 요청이 그대로 다시 갔다');
  await page.waitFor('맥스의 말', `document.querySelector('.dialog-text').textContent.includes('이번에는 시작했어요')`);
  ok('네 번째 시도에서 맥스가 시작했고 미션이 done이에요');
  await page.shot('맥스-다시-시작');
  fakes.assertClean();
  assert.ok(!serverOut().includes('Error'), `서버 출력에 오류가 있어요:\n${serverOut()}`);
  stop();
}

/** 저장소 미션: 입력창에서 저장소를 고르고, 가짜 일꾼이 자기 브랜치에서 일하고, 일꾼 카드의 “합치기”로 기준 브랜치가 나아간다 */
async function repoMission() {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bureau-e2e-repo-')));
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, 'user-repo');
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Tester', '-c', 'user.email=t@test', ...args], { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(repo, 'README.md'), '내 앱\n');
  git('add', '-A');
  git('commit', '-q', '-m', '처음');
  const base = git('rev-parse', 'HEAD');
  const plan = { tasks: [{ key: 'api', title: 'API 만들기', brief: 'BRIEF-API src/api.ts를 만들어 주세요.', role: 'code', agent: 'claude' }] };
  const { fakes, page, serverOut, stop } = await openOffice({
    claude: {
      launches: [
        { match: '^(?![\\s\\S]*--resume)(?=[\\s\\S]*--mcp-config )', steps: [...turn({ mcp: { tool: 'office_plan', args: plan, expectResult: '1개를 받았어요' } }, { say: { text: '에이다에게 맡겼어요.' } }), ...anyTurn(4)] },
        { match: 'BRIEF-API', steps: turn({ writeFile: { path: 'src/api.ts', content: 'export const api = 1;\n' } }, { tool: { name: 'Write', input: { file_path: '{{cwd}}/src/api.ts' } } }, { wait: 300 }, done('SUMMARY-API src/api.ts')) },
      ],
    },
    codex: { launches: [] },
  }, 'c', { BUREAU_WORKTREES: path.join(tmp, 'worktrees') });

  step('입력창에서 “코드 저장소”를 고르고 경로를 확인해요');
  await page.click('.where .seg button', '코드 저장소');
  await page.type('.where .repo-path', repo);
  await page.click('.where .btn', '확인');
  await page.waitFor('저장소 이름과 기준 브랜치', `(document.querySelector('.where .repo-chip')?.textContent ?? '').includes('user-repo')`);
  const chip = await page.eval<string>(`document.querySelector('.where .repo-chip').textContent`);
  assert.match(chip, /user-repo.*기준 브랜치 main/);
  assert.ok(!chip.includes(tmp), '확인한 뒤에는 전체 경로 대신 저장소 이름만 보인다');
  ok(`입력창: “${chip.replace('바꾸기', '').trim()}”`);
  await page.shot('저장소-확인');

  step('미션을 시작하면 일꾼이 자기 브랜치에서 일하고 끝내요');
  await page.type('.composer textarea', '내 앱에 API를 만들어 주세요.');
  await page.click('.composer .btn.send', '시작');
  await page.waitFor('API 할 일 끝과 브랜치', `window.__bureau.useOffice.getState().tasks.api?.run.result?.branch !== undefined`, 30_000);
  await page.waitFor('미션이 쉼', `window.__bureau.useOffice.getState().settled !== null`, 30_000);
  const branch = await page.store<string>(`(s) => s.tasks.api.run.result.branch`);
  assert.equal(git('rev-parse', 'HEAD'), base, '미션 동안 사용자의 체크아웃은 그대로다');
  assert.equal(git('show', `${branch}:src/api.ts`), 'export const api = 1;');
  await page.waitFor('패널의 브랜치 줄', `(document.querySelector('.panel .branch-line')?.textContent ?? '').includes(${JSON.stringify(branch)})`);
  ok(`할 일 목록에 브랜치 ${branch}, 사무실이 커밋했어요`);
  await page.shot('브랜치-할일목록');

  const coder = await page.store<string>(`(s) => Object.values(s.agents).find((a) => a.task === 'API 만들기').name`);
  const openCard = async () => {
    await page.click('.icon-btn[title^="팀 전체"]');
    await page.click('.modal .who-row', coder);
    await page.waitFor('브랜치 카드', `!!document.querySelector('.branch-card')`);
  };

  step('체크아웃에 저장하지 않은 변경이 있으면 “합치기”가 꺼지고 이유가 보여요');
  writeFileSync(path.join(repo, 'scratch.txt'), '하던 일\n');
  await openCard();
  await page.waitFor('이유', `(document.querySelector('.branch-card .branch-why')?.textContent ?? '').includes('저장하지 않은 변경')`);
  assert.equal(await page.eval<boolean>(`document.querySelector('.branch-card .merge').disabled`), true);
  ok(`이유: ${await page.eval<string>(`document.querySelector('.branch-card .branch-why').textContent`)}`);
  await page.shot('합치기-막힘');
  await page.click('.modal .close');
  rmSync(path.join(repo, 'scratch.txt'));

  step('깨끗해지면 카드의 “합치기”를 눌러 기준 브랜치를 나아가게 해요');
  await openCard();
  await page.waitFor('합치기 켜짐', `document.querySelector('.branch-card .merge')?.disabled === false`);
  await page.shot('브랜치카드-합치기전');
  await page.click('.branch-card .merge', '합치기');
  await page.waitFor('합쳤어요', `window.__bureau.useOffice.getState().tasks.api.run.result.merged === true`);
  await page.waitFor('카드 표시', `(document.querySelector('.branch-card .branch-badge')?.textContent ?? '').includes('합쳤어요')`);
  assert.notEqual(git('rev-parse', 'HEAD'), base, '기준 브랜치가 나아갔다');
  assert.equal(git('rev-parse', 'HEAD^2'), git('rev-parse', branch));
  assert.equal(git('show', 'HEAD:src/api.ts'), 'export const api = 1;');
  ok(`main: ${base.slice(0, 7)} → ${git('rev-parse', '--short', 'HEAD')}`);
  await page.shot('합친뒤');

  fakes.assertClean();
  assert.ok(!serverOut().includes('Error'), `서버 출력에 오류가 있어요:\n${serverOut()}`);
  stop();
}

const only = flag('--only');
try {
  prepare();
  if (!only || only === 'office') await main();
  if (!only || only === 'lead') await leadFailure();
  if (!only || only === 'repo') await repoMission();
  console.log(`\n통과했어요. 스크린샷: ${SHOTS}`);
} catch (e) {
  console.error(`\n실패했어요: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  cleanup();
}
