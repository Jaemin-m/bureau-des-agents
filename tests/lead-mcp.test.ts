// 맥스의 MCP 끝점: 토큰, Host, Origin, 본문 크기를 지키고, 토큰이 가리키는 미션 밖은 건드리지 못한다.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import type { OfficeEvent } from '../shared/protocol.ts';
import { Conductor } from '../server/conductor/shell.ts';
import { turn, type LaunchScript } from './support/fake-agent.ts';
import { conductorRig, type Rig } from './support/scenario.ts';

interface Res { status: number; body: any }

function post(base: string, urlPath: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<Res> {
  const u = new URL(base);
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: urlPath, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8').on('data', (c: string) => { text += c; }).on('end', () => resolve({ status: res.statusCode!, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : data);
  });
}

const call = (name: string, args: unknown, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const textOf = (r: Res) => ({ text: r.body.result.content[0].text as string, isError: r.body.result.isError as boolean });

function tokenOf(rig: Rig, marker: string): string {
  const l = rig.fakes.launches('claude').find((x) => x.stdin.some((s) => s.includes(marker)));
  assert.ok(l, `${marker} 맥스가 떴다`);
  const config = JSON.parse(l.argv[l.argv.indexOf('--mcp-config') + 1]) as { mcpServers: { office: { url: string } } };
  return /\/lead\/([0-9a-f]{32})\/mcp$/.exec(config.mcpServers.office.url)![1];
}

const lead = (mission: string, key: string): LaunchScript => ({
  match: mission,
  steps: turn({ mcp: { tool: 'office_plan', args: { tasks: [{ key, title: `${key} 일`, brief: `BRIEF-${key}`, role: 'code' }] } } }, { say: { text: '맡겼어요.' } }),
});
const hanging = (key: string): LaunchScript => ({ match: `BRIEF-${key}`, steps: turn({ hang: true }) });
const working = (id: string) => (es: OfficeEvent[]) => es.some((e) => e.k === 'worker' && e.id === id && e.phase === 'working');
const workerOf = (c: Conductor) => Object.keys(c.view().workers)[0];

test('맥스의 MCP: 토큰·Host·Origin·크기를 지키고, 다른 미션은 못 건드리고, 같은 requestId는 한 번만 전한다', async () => {
  const rig = await conductorRig({ scripts: { claude: { launches: [lead('MISSION-A', 'a1'), lead('MISSION-B', 'b1'), hanging('a1'), hanging('b1')] } } });
  const ma = rig.mission('a');
  const mb = rig.mission('b');
  const a = Conductor.create(ma.deps, 'MISSION-A 일을 해 주세요.');
  const b = Conductor.create(mb.deps, 'MISSION-B 일을 해 주세요.');
  await ma.until((es) => es.some((e) => e.k === 'hire'));
  await mb.until((es) => es.some((e) => e.k === 'hire'));
  const [wa, wb] = [workerOf(a), workerOf(b)];
  await ma.until(working(wa));
  await mb.until(working(wb));
  const tokenA = tokenOf(rig, 'MISSION-A');
  const pathA = `/lead/${tokenA}/mcp`;
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

  const ok = await post(rig.base, pathA, list);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.result.tools.map((t: { name: string }) => t.name), ['office_plan', 'office_message', 'office_cancel', 'office_status']);
  assert.equal((await post(rig.base, pathA, { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

  assert.equal((await post(rig.base, '/lead/mcp', list)).status, 404, '토큰이 없다');
  assert.equal((await post(rig.base, `/lead/${'0'.repeat(32)}/mcp`, list)).status, 404, '틀린 토큰');
  assert.equal((await post(rig.base, pathA, list, { origin: 'http://evil.example' })).status, 403, 'Origin 헤더가 있다');
  const port = new URL(rig.base).port;
  assert.equal((await post(rig.base, pathA, list, { host: `evil.example:${port}` })).status, 403, '루프백이 아닌 Host');
  assert.equal((await post(rig.base, pathA, list, { host: '127.0.0.1:1' })).status, 403, '다른 포트의 Host');
  assert.equal((await post(rig.base, pathA, `{"pad":"${'x'.repeat(300 * 1024)}"}`)).status, 413, '256KB가 넘는 본문');
  assert.equal((await post(rig.base, pathA, '', {}, 'GET')).status, 405);

  const before = mb.events().length;
  const cross = textOf(await post(rig.base, pathA, call('office_message', { to: wb, text: 'CROSS 다른 미션에 말하기' })));
  assert.equal(cross.isError, true, '다른 미션의 토큰으로는 이 미션의 일꾼에게 말할 수 없다');
  assert.equal(mb.events().length, before, '다른 미션에는 아무 일도 없다');
  const status = textOf(await post(rig.base, pathA, call('office_status', {})));
  assert.ok(status.text.includes('a1') && !status.text.includes('b1'), '상태도 자기 미션만 보인다');
  const tokenB = tokenOf(rig, 'MISSION-B');
  assert.ok(textOf(await post(rig.base, `/lead/${tokenB}/mcp`, call('office_status', {}))).text.includes('b1'));

  const msg = { to: wa, text: 'DUP 테스트도 해 주세요.', requestId: 'r-1' };
  const first = textOf(await post(rig.base, pathA, call('office_message', msg)));
  const again = textOf(await post(rig.base, pathA, call('office_message', msg, 2)));
  assert.equal(first.isError, false);
  assert.deepEqual(again, { text: '이미 받은 메시지예요.', isError: false });
  assert.equal(ma.events().filter((e) => e.k === 'msg' && e.text === msg.text).length, 1, '같은 requestId는 한 번만 전한다');
  assert.equal(a.view().workers[wa].inbox.length, 1);

  const bad = textOf(await post(rig.base, pathA, call('office_plan', { tasks: 'x' })));
  assert.equal(bad.isError, true, '모양이 틀린 인자는 맥스가 읽을 오류로 돌아간다');

  await a.close();
  assert.equal((await post(rig.base, pathA, list)).status, 404, '닫힌 미션의 토큰은 회수된다');
  await b.close();
  rig.fakes.assertClean();
  await rig.stop();
});
