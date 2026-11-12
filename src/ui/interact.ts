// 사무실 안을 클릭했을 때 일어나는 일: 물건마다 쓸모(또는 깜짝 장치)가 있다.
import { jukebox } from '../audio/music.ts';
import { sfx } from '../audio/sfx.ts';
import { say } from '../audio/voice.ts';
import { world } from '../engine/instance.ts';
import type { Hit } from '../engine/hits.ts';
import { savePref, useOffice, type Tod } from '../state/store.ts';

const TOD_NEXT: Record<Tod, Tod> = { auto: 'day', day: 'evening', evening: 'night', night: 'auto' };

const QUOTES = [
  '이번 분기 목표: 반복 업무 0개.',
  '사무실 규칙 1번: 맡길 수 있는 건 다 맡긴다.',
  '여기선 아무도 야근 시간을 안 세요. 셀 필요가 없거든요.',
];

let jukeClicks: number[] = [];

/** 저녁 모드: 미러볼, 음악, 그리고 춤추는 팀 전체. */
export function party() {
  world.disco(16);
  if (!jukebox.playing) jukebox.play(2);
  void say('afterwork', true);
  sfx('done');
}

/** 일꾼의 카드를 열고, 입력창의 받는 사람도 그 일꾼으로 맞춘다. */
export function openAgent(id: string) {
  sfx('open');
  useOffice.setState({ modal: { kind: 'agent', id }, recipient: id });
}

export function interact(hit: Hit) {
  const st = useOffice.getState();
  if (hit.kind === 'actor') {
    if (hit.id === 'chef') {
      sfx('click');
      world.chef.happyUntil = world.time + 1.5;
      useOffice.setState({ draft: ' ', recipient: null });
      return;
    }
    openAgent(hit.id);
    return;
  }
  if (hit.kind === 'cat') {
    world.petCat();
    sfx('meow');
    return;
  }
  const id = hit.id;
  if (id.startsWith('desk-') || id.startsWith('chair-desk-')) {
    // 에이전트 책상: 앉아 있으면 그 에이전트 카드, 아니면 그 구역과 도구 소개
    const deskId = id.startsWith('chair-') ? id.slice(6) : id;
    const who = [...world.actors.values()].find((a) => a.seated && a.seat?.deskId === deskId);
    if (who) openAgent(who.id);
    else { sfx('open'); useOffice.setState({ modal: { kind: 'team', role: hit.role } }); }
    return;
  }
  if (id.startsWith('zone:')) { sfx('open'); useOffice.setState({ modal: { kind: 'team', role: hit.role } }); return; }
  if (id.startsWith('plant-')) {
    const f = id;
    world.wiggle(f, 0, 0);
    sfx('tick');
    return;
  }
  switch (id) {
    case 'board': case 'chefDesk': sfx('open'); useOffice.setState({ modal: { kind: 'board' } }); return;
    case 'chefChair': sfx('click'); useOffice.setState({ draft: ' ', recipient: null }); return;
    case 'clock': sfx('open'); useOffice.setState({ modal: { kind: 'clock' } }); return;
    case 'rack': sfx('open'); useOffice.setState({ modal: { kind: 'machine' } }); return;
    case 'printer': sfx('open'); useOffice.setState({ modal: { kind: 'files' } }); return;
    case 'shelf': sfx('open'); useOffice.setState({ historyOpen: true }); return;
    case 'door': sfx('open'); useOffice.setState({ modal: { kind: 'team' } }); return;
    case 'neon': world.neonNext(); sfx('check'); return;
    case 'window': { const n = TOD_NEXT[st.tod]; useOffice.setState({ tod: n }); savePref('tod', n); sfx('click'); return; }
    case 'coffee': world.coffee(); sfx('pour'); return;
    case 'cooler': world.cooler(); sfx('glug'); return;
    case 'lamp': case 'lamp-r': world.toggleLamp(id); sfx('click'); return;
    case 'easel': case 'bin': case 'tableLow': case 'sofa': world.wiggle(id, 0, 0); sfx('tick'); return;
    case 'poster': st.toast('info', QUOTES[Math.floor(Math.random() * QUOTES.length)]); sfx('click'); return;
    case 'jukebox': {
      // 빠르게 다섯 번 클릭하면 파티가 시작된다
      const now = Date.now();
      jukeClicks = [...jukeClicks.filter((t) => now - t < 2500), now];
      if (jukeClicks.length >= 5) { jukeClicks = []; useOffice.setState({ modal: null }); party(); return; }
      sfx('open');
      useOffice.setState({ modal: { kind: 'jukebox' } });
      return;
    }
  }
}
