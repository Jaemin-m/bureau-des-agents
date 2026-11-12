// 데모 미션을 지금의 스토어에 접어 넣은 결과를 tests/fixtures/demo-store-snapshot.json에 쓴다.
//   node scripts/snapshot-demo.ts     (npm run snapshot-demo)
// 클라이언트 상태를 일부러 바꿨을 때만 다시 만든다. 바뀐 부분은 git diff로 검토한다.
import { writeFileSync } from 'node:fs';
import { foldDemo } from '../tests/support/demo-fold.ts';

const { snapshot, events } = await foldDemo();
const out = new URL('../tests/fixtures/demo-store-snapshot.json', import.meta.url);
writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n');
console.log(`스냅샷 작성 완료: tests/fixtures/demo-store-snapshot.json (이벤트 ${events}개)`);
