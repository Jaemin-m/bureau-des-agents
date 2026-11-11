// 화면 속 사무실: 작은 픽셀 아트 이미지를 흐림 없이 키우고, 그 위에 선명한 글자로
// 로봇들의 말풍선(지금 실제로 하는 일)과 허락 요청을 띄운다.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ROLES } from '../../shared/activity.ts';
import type { ActKind } from '../../shared/protocol.ts';
import { camera, director, renderer, timeOfDay, world } from '../engine/instance.ts';
import { hitAt, type Hit } from '../engine/hits.ts';
import { jukebox } from '../audio/music.ts';
import { interact } from './interact.ts';
import { H, W } from '../engine/layout.ts';
import { sfx } from '../audio/sfx.ts';
import { useOffice, type AskView } from '../state/store.ts';

const ICON: Record<ActKind, string> = {
  search: '🔎', web: '🌐', read: '📖', write: '✍️', edit: '✏️', bash: '💻', plan: '📋', skill: '🎓', mcp: '🔌', other: '⚙️',
};

/** 그리기 비용(사무실이 컴퓨터를 뜨겁게 만들지 않는지 확인용). */
export const perf = { frames: 0, ms: 0 };

/** 로봇에 붙은 말풍선: React를 거치지 않고 매 장면 위치를 옮긴다. */
const bubbleEls = new Map<string, HTMLElement>();

function placeBubbles(scale: number) {
  const stageW = W * scale;
  for (const [id, el] of bubbleEls) {
    const a = world.actors.get(id);
    if (!a) continue;
    const seated = a.seated && !!a.seat;
    const x = Math.round(a.x * scale);
    const y = Math.round(((seated ? a.seat!.y : a.y) - (seated ? 19 : 22)) * scale);
    // 같은 줄 책상에서는 말풍선을 하나 걸러 조금 더 위로 올린다(덜 겹친다)
    const lift = seated && Math.round(a.seat!.x / 32) % 2 === 0 ? 1 : 0;
    el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    el.style.opacity = a.alpha.toFixed(2);
    el.dataset.lift = String(lift);
    // 사무실 가장자리 말풍선은 화면 안으로 들인다(꼬리는 로봇에 그대로 둔다)
    const b = el.firstElementChild as HTMLElement | null;
    let dx = 0;
    if (b) {
      const half = b.offsetWidth / 2;
      if (x - half < 4) dx = 4 - (x - half);
      else if (x + half > stageW - 4) dx = stageW - 4 - (x + half);
    }
    el.style.setProperty('--dx', `${Math.round(dx)}px`);
  }
}

export function Office() {
  const wrap = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(2);
  const tod = useOffice((s) => s.tod);
  const vertical = useOffice((s) => s.vertical || s.portrait);
  const todRef = useRef(tod);
  todRef.current = tod;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  // 크기: 들어갈 수 있는 가장 큰 크기(세로 화면에서는 화면 너비 전체).
  useLayoutEffect(() => {
    const el = wrap.current!;
    const fit = () => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const w = r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const h = r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const f = vertical ? w / W : Math.min(w / W, h / H);
      setScale(Math.max(0.5, Math.floor(f * 16) / 16));
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();
    return () => ro.disconnect();
  }, [vertical]);

  // 애니메이션 루프: 움직일 때 초당 24장, 쉴 때 8장, 탭이 숨겨지면 그리지 않는다.
  // 사무실은 아주 작게(352 × 256) 그린다. 어떤 크기에서도 픽셀이 선명하다.
  useEffect(() => {
    const vis = canvas.current!;
    const vg = vis.getContext('2d')!;
    const low = document.createElement('canvas');
    low.width = W;
    low.height = H;
    const lg = low.getContext('2d')!;
    lg.imageSmoothingEnabled = false;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let active = true;
    let lastCss = '';
    // 그림을 정수 배로 키운 뒤(선명한 픽셀), 브라우저가 아주 살짝 부드럽게 정확한 크기로 맞춘다.
    // 장면마다 한 번만 하는 작업이다.
    const present = () => {
      const dpr = window.devicePixelRatio || 1;
      const k = Math.max(1, Math.ceil(scaleRef.current * dpr - 0.001));
      if (vis.width !== W * k || vis.height !== H * k) { vis.width = W * k; vis.height = H * k; }
      vg.imageSmoothingEnabled = false;
      vg.drawImage(low, 0, 0, W * k, H * k);
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = (now - last) / 1000;
      last = now;
      if (document.hidden) return;
      acc += dt;
      const st = useOffice.getState();
      // 카메라: 촬영 모드에서는 연출가가 알아서 찍는다(사무실 둘러보기 중에는 빼고)
      director.enabled = st.filming && st.cameraAuto && !st.tour;
      director.tick();
      const camMoving = camera.update(dt);
      // 사무실을 한 장면씩 촬영할 때(캡처 스크립트): 모든 장면을 그리고, 음악 박자는
      // 주크박스가 아니라 촬영 쪽에서 받는다
      const cap = (window as unknown as { __CAPTURE?: { music?: () => { on: boolean; level: number; beat: boolean } } }).__CAPTURE;
      const m = cap?.music?.();
      const level = m ? m.level : jukebox.sample();
      world.setMusic(m ? m.on : jukebox.playing, level, m ? m.beat : jukebox.beat);
      if (!cap && acc < (active || camMoving ? 1 / 24 : 1 / 8)) return;
      const t0 = performance.now();
      active = world.update(acc);
      acc = 0;
      renderer.draw(lg, world, timeOfDay(todRef.current), new Date());
      present();
      const { transform, zoomed } = camera.css(scaleRef.current);
      if (stage.current && transform !== lastCss) {
        stage.current.style.transform = transform;
        vis.style.imageRendering = zoomed ? 'pixelated' : 'auto';
        // 클로즈업에서는 화면 밖을 자르고, 와이드 샷에서는 말풍선이 밖으로 나가도 된다
        const frame = stage.current.parentElement;
        if (frame) frame.dataset.zoomed = zoomed ? '1' : '0';
        lastCss = transform;
      }
      placeBubbles(scaleRef.current);
      perf.frames++;
      perf.ms += performance.now() - t0;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 마우스: 아래에 뭐가 있는지(툴팁), 클릭하면 상호작용, 휠로 확대.
  const toWorld = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const hover = useRef<Hit | null>(null);
  const onMove = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.bubble.ask')) return;
    const p = toWorld(e);
    const h = hitAt(world, p.x, p.y);
    hover.current = h;
    const el = tip.current;
    if (!el || !wrap.current) return;
    if (!h || useOffice.getState().filming) { el.style.opacity = '0'; wrap.current.style.cursor = ''; return; }
    const r = wrap.current.getBoundingClientRect();
    el.textContent = h.label;
    el.style.opacity = '1';
    el.style.transform = `translate(${Math.round(e.clientX - r.left + 14)}px, ${Math.round(e.clientY - r.top + 16)}px)`;
    wrap.current.style.cursor = 'pointer';
  };
  const onLeave = () => { if (tip.current) tip.current.style.opacity = '0'; hover.current = null; };
  const onClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.bubble.ask')) return;
    const p = toWorld(e);
    const h = hitAt(world, p.x, p.y);
    if (h) interact(h);
  };
  const onWheel = (e: React.WheelEvent) => {
    const p = toWorld(e);
    const z = Math.max(1, Math.min(2.6, camera.tzoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    if (z <= 1.01) camera.wide(6);
    else camera.shot(p.x, p.y, z, 8);
  };

  return (
    <div className="office" ref={wrap} onPointerMove={onMove} onPointerLeave={onLeave} onClick={onClick} onWheel={onWheel} onDoubleClick={() => camera.wide(4)}>
      <div className="office-frame" style={{ width: W * scale, height: H * scale }}>
        <div className="office-stage" ref={stage} style={{ width: W * scale, height: H * scale, ['--s' as string]: scale }}>
          <canvas ref={canvas} className="office-canvas" style={{ width: W * scale, height: H * scale }} />
          <Bubbles />
        </div>
        <LiveBadge />
      </div>
      <div className="office-tip" ref={tip} />
    </div>
  );
}

/** 촬영 모드: TV처럼 “LIVE” 표시와 경과 시간. */
function LiveBadge() {
  const filming = useOffice((s) => s.filming);
  const busy = useOffice((s) => s.busySince !== null);
  const replaying = useOffice((s) => s.replaying);
  if (!filming || !busy) return null;
  return <div className="live-badge"><i />{replaying ? '다시 재생' : 'LIVE'}</div>;
}

function subscribeRoster(cb: () => void) {
  const off = world.onRoster(cb);
  return () => { off(); };
}

interface View {
  mode: 'ask' | 'full' | 'icon' | 'tag' | 'none';
  name: string;
  color: string;
  text?: string;
  icon?: string;
  ask?: AskView;
}

/** 더 짧은 말풍선. 프랑스어로 녹화된 옛 미션의 « » 인용은 “:” 뒤로 옮긴다(한국어 문구는 그대로). */
const short = (label: string) => label.replace(/\s«\s?(.+?)\s?»/, ' : $1');
/** 말풍선 폭 어림: 한글·전각 문자는 영문의 약 두 배 폭이다. */
const textUnits = (s: string) => s.length + (s.match(/[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g)?.length ?? 0) * 0.8;

function Bubbles() {
  const version = useSyncExternalStore(subscribeRoster, () => world.rosterVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ids = useMemo(() => [...world.actors.keys()], [version]);
  const now = useNow(400);
  const agents = useOffice((s) => s.agents);
  const chef = useOffice((s) => s.chef);
  const asks = useOffice((s) => s.asks);
  const busy = useOffice((s) => s.busySince !== null);
  const order = useOffice((s) => s.order);
  const filming = useOffice((s) => s.filming);
  const vertical = useOffice((s) => s.vertical || s.portrait);

  // 가장 최근 작업에만 전체 말풍선을 띄우고(나머지는 아이콘만), 두 말풍선이 겹치지 않게
  // 최신 것부터 오래된 순으로 고른다.
  const fresh = new Set<string>();
  {
    const boxes: { x: number; y: number; w: number }[] = [];
    const chefActor = world.actors.get('chef');
    if (chefActor) boxes.push({ x: chefActor.x, y: (chefActor.seated && chefActor.seat ? chefActor.seat.y : chefActor.y) - 20, w: 86 });
    const cands = ids.filter((id) => id !== 'chef' && world.actors.get(id)?.seated)
      .map((id) => ({ id, at: agents[id]?.act?.at ?? 0, label: agents[id]?.act?.label ?? '' }))
      .filter((x) => now - x.at < 2800)
      .sort((a, b) => b.at - a.at);
    for (const c of cands) {
      if (fresh.size >= (vertical ? 2 : 3)) break;
      const a = world.actors.get(c.id)!;
      const lift = Math.round(a.seat!.x / 32) % 2 === 0 ? 12 : 0;
      const box = { x: a.seat!.x, y: a.seat!.y - 20 - lift, w: Math.min(80, textUnits(short(c.label)) * 3.1 + 14) };
      if (boxes.some((b) => Math.abs(b.x - box.x) < (b.w + box.w) / 2 + 2 && Math.abs(b.y - box.y) < 24)) continue;
      boxes.push(box);
      fresh.add(c.id);
    }
  }
  const askOf = (id: string) => Object.values(asks).find((a) => a.who === id);

  const view = (id: string): View => {
    const actor = world.actors.get(id);
    const isChef = id === 'chef';
    const a = isChef ? null : agents[id];
    const role = isChef ? 'chef' : a?.role ?? actor?.role ?? 'renfort';
    const base = { name: isChef ? '맥스' : a?.name ?? actor?.name ?? '', color: ROLES[role].color };
    // 사무실 둘러보기용 데모 팀: 이름만 보여 준다
    if (!isChef && !a && actor) return { ...base, mode: filming ? 'none' : 'tag' };
    const ask = askOf(id);
    if (ask) return { ...base, mode: 'ask', ask };
    if (isChef) {
      const working = order.filter((k) => agents[k]?.status === 'working' || agents[k]?.status === 'reporting').length;
      if (chef.typing) return { ...base, mode: 'full', text: lastSentence(chef.typing, 70) };
      if (chef.say && now - chef.sayAt < 6000) return { ...base, mode: 'full', text: firstSentence(chef.say, 70) };
      if (chef.act && now - chef.act.at < 5000) return { ...base, mode: 'full', text: short(chef.act.label), icon: ICON[chef.act.kind] };
      if (busy && working > 0) return { ...base, mode: 'full', text: `팀 기다리는 중: 보고서 ${order.length}개 중 ${order.length - working}개`, icon: '⏳' };
      if (busy) return { ...base, mode: 'full', text: '…' };
      return { ...base, mode: filming ? 'none' : 'tag' };
    }
    if (!a || !actor) return { ...base, mode: 'none' };
    // 걷는 중: 이름만(보고서를 들고 가면 종이 아이콘도)
    if (actor.moving || !actor.seated) return { ...base, mode: 'tag', icon: actor.carrying ? '📄' : undefined };
    if (a.act && now - a.act.at < 7000) {
      return fresh.has(id) ? { ...base, mode: 'full', text: short(a.act.label), icon: ICON[a.act.kind] } : { ...base, mode: 'icon', icon: ICON[a.act.kind] };
    }
    return { ...base, mode: filming ? 'none' : 'tag' };
  };

  return <>{ids.map((id) => <Bubble key={id} id={id} v={view(id)} />)}</>;
}

function useNow(every: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

const lastSentence = (s: string, n = 96) => {
  const t = s.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(-n);
  const i = cut.search(/[.!?…]\s/);
  return '…' + (i >= 0 && i < n - 20 ? cut.slice(i + 2) : cut.slice(cut.indexOf(' ') + 1));
};
const firstSentence = (s: string, n = 96) => {
  const t = s.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{12,}?[.!?…])(\s|$)/);
  const one = m ? m[1] : t;
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
};

function Bubble({ id, v }: { id: string; v: View }) {
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (el) bubbleEls.set(id, el);
    else bubbleEls.delete(id);
  }, [id]);
  return (
    <div className={`bubble-anchor ${id === 'chef' ? 'is-chef' : ''}`} ref={ref} style={{ ['--c' as string]: v.color }}>
      {v.mode === 'ask' && v.ask ? <AskBubble ask={v.ask} name={v.name} />
        : v.mode === 'full' ? (
          <div className="bubble">
            <span className="bubble-name">{v.name}</span>
            <span className="bubble-text">{v.icon && <i>{v.icon}</i>}{v.text}</span>
          </div>
        ) : v.mode === 'icon' ? <div className="bubble-icon" title={v.name}>{v.icon}</div>
          : v.mode === 'tag' ? <div className="tag">{v.icon ? `${v.icon} ` : ''}{v.name}</div> : null}
    </div>
  );
}

function AskBubble({ ask, name }: { ask: AskView; name: string }) {
  const send = useOffice((s) => s.send);
  const answer = (allow: boolean) => {
    sfx(allow ? 'yes' : 'no');
    send({ t: 'answer', requestId: ask.requestId, allow });
  };
  return (
    <div className="bubble ask">
      <span className="bubble-name">🙋 {name}</span>
      <span className="bubble-text">{short(ask.label)}</span>
      {ask.full ? (
        <span className="ask-actions">
          <button className="yes" onClick={() => answer(true)}>네</button>
          <button className="no" onClick={() => answer(false)}>아니요</button>
        </span>
      ) : <span className="ask-more">자세한 내용은 화면 아래 ↓</span>}
    </div>
  );
}
