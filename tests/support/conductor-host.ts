// 다른 프로세스에서 진행자 하나를 돌리는 작은 서버. 테스트가 이 프로세스를 SIGKILL로 죽여 서버가 갑자기 꺼지는 경우를 만든다.
// 설정은 CONDUCTOR_HOST(JSON), 이벤트는 stdout에 한 줄에 하나씩 쓴다.
import http from 'node:http';
import { LeadMcp } from '../../server/conductor/lead-mcp.ts';
import { Conductor, type ConductorDeps } from '../../server/conductor/shell.ts';
import { conductorDeps } from './scenario.ts';

const cfg = JSON.parse(process.env.CONDUCTOR_HOST ?? '{}') as { missionId: string; folder: string; stateFile: string; opening: string; repo?: ConductorDeps['repo'] };
const mcp = new LeadMcp();
const server = http.createServer((req, res) => { if (!mcp.handle(req, res)) { res.writeHead(404); res.end(); } });
server.listen(0, '127.0.0.1', () => {
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  Conductor.create(conductorDeps({ ...cfg, mcp, base, emit: (ev) => process.stdout.write(`${JSON.stringify(ev)}\n`) }), cfg.opening);
});
