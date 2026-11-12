// 화면 아래, RPG처럼: 맥스가 말을 걸고(글자가 한 자씩 써진다), 사용자는 키보드나 목소리로 답한다.
// 글을 입력하는 곳은 여기뿐이다. 요청 하나면 팀이 일을 시작한다.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ROLES } from '../../shared/activity.ts';
import { sfx } from '../audio/sfx.ts';
import { world } from '../engine/instance.ts';
import { robotSprite } from '../engine/robots.ts';
import { canResume, phaseOf, recipientOf, useOffice } from '../state/store.ts';
import { tidy } from './tidy.ts';
import { dictationHelp, useDictation } from './voice.ts';

export const EXAMPLES: { label: string; prompt: string }[] = [
  {
    label: '🔎 경쟁사 분석',
    prompt: '주요 경쟁사 5곳을 분석해 줘. 각각 상품, 가격, 고객 평가를 알아봐 줘. 경쟁사마다 리서처를 한 명씩 보내고, 비교표와 차별화할 수 있는 구체적인 아이디어 3개를 정리해 줘.',
  },
  {
    label: '📰 이번 주 AI 소식',
    prompt: '이번 주 AI 소식을 정리해 줘. 창업자에게 중요한 새 소식 5개(도구, 발표, 활용법)를 골라, 각각 나한테 뭐가 달라지는지 한 문장과 출처 링크를 붙여 줘.',
  },
  {
    label: '🌐 판매 페이지',
    prompt: '내 상품의 판매 페이지를 만들어 줘. 파일 하나짜리 모던한 웹 페이지로, 강한 제목, 장점, 나중에 채울 후기 섹션, 행동 유도 버튼을 넣어 줘. 작가에게 문구 검토도 맡겨 줘.',
  },
  {
    label: '✍️ 링크드인 글 3개',
    prompt: '내 일에 대한 링크드인 글 3개를 써 줘. 글마다 첫 문장을 다르게 하고, 셋 중 가장 좋은 글로 HTML 인용 이미지도 만들어 줘.',
  },
];

const stripMd = (s: string) =>
  tidy(s).replace(/```[\s\S]*?```/g, ' ').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]+/g, '').replace(/^\s*[-•]\s+/gm, '• ').replace(/\n{2,}/g, '\n').trim();

/** 맥스의 대사. 옛날 게임처럼 작은 “삑” 소리와 함께 한 자씩 써진다. */
function useTypewriter(text: string, cps = 55) {
  const [n, setN] = useState(0);
  const shown = useRef('');
  useEffect(() => {
    // 새 텍스트가 지금 보이는 텍스트에 이어지면 계속 쓰고, 아니면 처음부터 다시 쓴다
    if (!text.startsWith(shown.current)) setN(0);
  }, [text]);
  useEffect(() => {
    if (n >= text.length) return;
    const t = setTimeout(() => {
      const step = text.length - n > 260 ? 8 : 2;
      setN((x) => Math.min(text.length, x + step));
      if (n % 6 === 0) sfx('blip', 0.85 + Math.random() * 0.3);
    }, (1000 / cps) * 2);
    return () => clearTimeout(t);
  }, [n, text, cps]);
  const out = text.slice(0, Math.min(n, text.length));
  shown.current = out;
  return { out, done: n >= text.length };
}

/** 크게 그린 맥스의 얼굴. 눈을 깜빡이고, 일이 끝나면 웃는다. */
function Portrait({ happy }: { happy: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const g = ref.current!.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    let blink = 0;
    const draw = () => {
      const chef = world.chef;
      const eyes = happy ? 'happy' : blink > 0 ? 'blink' : chef.eyes === 'blink' ? 'open' : chef.eyes === 'happy' ? 'happy' : chef.eyes;
      g.clearRect(0, 0, 64, 64);
      g.drawImage(robotSprite('chef', 'stand', 'down', 0, eyes), 2, 0, 16, 16, 0, 0, 64, 64);
      if (blink > 0) blink--;
      else if (Math.random() < 0.02) blink = 2;
    };
    draw();
    const t = setInterval(draw, 120);
    return () => clearInterval(t);
  }, [happy]);
  return <canvas ref={ref} width={64} height={64} className="portrait" />;
}

export function Dialog() {
  const connection = useOffice((s) => s.connection);
  const claude = useOffice((s) => s.claude);
  const mission = useOffice((s) => s.mission);
  const busy = useOffice((s) => s.busySince !== null);
  const replaying = useOffice((s) => s.replaying);
  const chef = useOffice((s) => s.chef);
  const final = useOffice((s) => s.final);
  const tour = useOffice((s) => s.tour);

  let text: string;
  if (tour) text = tour.text;
  else if (connection === 'offline') text = 'Claude Code에 연결되지 않았어요. 사무실 폴더에서 “npm start”를 실행하면 바로 시작할게요.';
  else if (claude && !claude.found) text = '이 컴퓨터에서 Claude Code를 찾을 수 없어요. 설치하고(claude.com/claude-code) 로그인한 다음 사무실을 다시 실행해 주세요.';
  else if (!mission) text = '안녕하세요! 저는 이 사무실 팀장 맥스예요. 필요한 걸 말해 주세요. 팀을 꾸려서 눈앞에서 바로 일할게요.';
  else if (chef.typing) text = stripMd(chef.typing);
  else if (final && !busy) text = stripMd(final.text) || (final.ok ? '다 됐어요!' : '미션을 멈췄어요.');
  else if (chef.say) text = stripMd(chef.say);
  else text = busy ? '요청을 읽는 중…' : '';

  const { out } = useTypewriter(text);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [out]);

  return (
    <footer className="dialog">
      <div className="dialog-box">
        <div className="dialog-face"><Portrait happy={!!final?.ok && !busy} /></div>
        <div className="dialog-main">
          <div className="dialog-name">맥스 <span>팀장</span>{replaying && <em className="pill replay">다시 재생</em>}</div>
          <div className="dialog-text" ref={box}>{out}<span className="caret" /></div>
        </div>
      </div>
      <Composer />
    </footer>
  );
}

function Composer() {
  const mission = useOffice((s) => s.mission);
  const busy = useOffice((s) => s.busySince !== null);
  const replaying = useOffice((s) => s.replaying);
  const send = useOffice((s) => s.send);
  const draft = useOffice((s) => s.draft);
  const demo = useOffice((s) => s.connection === 'demo');
  const resumable = useOffice(canResume);
  const worker = useOffice((s) => { const id = recipientOf(s); return id === 'chef' ? undefined : s.agents[id]; });
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;

  // 다른 곳에서 고른 예시(또는 “수정 요청”)가 입력창을 채운다
  useEffect(() => {
    if (!draft) return;
    setText(draft === ' ' ? '' : draft);
    useOffice.setState({ draft: '' });
    setTimeout(() => area.current?.focus(), 30);
  }, [draft]);

  const getBase = useCallback(() => textRef.current, []);
  const dict = useDictation(getBase, setText);

  const mode: 'new' | 'steer' | 'retouch' = !mission ? 'new' : busy ? 'steer' : 'retouch';
  const resting = worker ? ['idle', 'stopped', 'failed', 'retired'].includes(phaseOf(worker)) : false;
  const placeholder = worker
    ? (resting ? `${worker.name}에게 이어서 시킬 일을 적어 주세요.` : `${worker.name}에게 할 말을 적어 주세요.`)
    : mode === 'new'
      ? '맥스에게 원하는 걸 말해 주세요… (예: 경쟁사 5곳 분석해 줘)'
      : mode === 'steer' ? '맥스에게 덧붙일 말이 있나요? 단계 사이에 읽어요.' : '맥스에게 수정을 요청하거나… 새 미션을 시작하세요.';
  const sendLabel = worker ? `${worker.name}에게 보내기` : mode === 'new' ? '시작' : '보내기';

  const submit = () => {
    const t = text.trim();
    if (!t || replaying) return;
    if (dict.listening) dict.stop();
    sfx('send');
    if (worker) send({ t: 'say', text: t, to: worker.id });
    else if (mode === 'new') send({ t: 'start', prompt: t });
    else send({ t: 'say', text: t });
    setText('');
  };

  return (
    <div className="composer">
      {mission && !replaying && <RecipientChip />}
      <div className={`composer-row ${dict.listening ? 'listening' : ''}`}>
        <textarea
          ref={area}
          value={text}
          rows={2}
          placeholder={demo ? '데모예요. 실제 버전은 내 컴퓨터에서 Claude Code로 돌아가요.' : replaying ? '다시 재생 중…' : placeholder}
          disabled={replaying}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
          }}
        />
        <button
          className={`mic ${dict.listening ? 'on' : ''}`}
          title={dict.listening ? '받아쓰기 멈추기' : '말로 입력(한국어)'}
          aria-label="말로 입력"
          disabled={replaying}
          onClick={() => (dict.listening ? dict.stop() : dict.start())}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12h-2Z" /></svg>
        </button>
        {busy && !replaying ? (
          <>
            {text.trim() && <button className="btn primary send" onClick={submit}>{sendLabel}</button>}
            <button className="btn stop" onClick={() => { sfx('click'); send({ t: 'stop' }); }}>■ 멈추기</button>
          </>
        ) : (
          <button className="btn primary send" disabled={!text.trim() || replaying} onClick={submit}>
            {sendLabel} <span aria-hidden="true">➜</span>
          </button>
        )}
        {resumable && (
          <button className="btn primary resume" title="멈춘 자리에서 팀이 다시 일해요" onClick={() => { sfx('click'); send({ t: 'resume' }); }}>▶ 이어서 하기</button>
        )}
        {mode === 'retouch' && !replaying && (
          <button className="btn ghost" title="이 미션을 정리하고 처음부터 시작해요" onClick={() => { sfx('click'); send({ t: 'new' }); }}>＋ 새 미션</button>
        )}
      </div>
      {dict.problem && (
        <div className="hint" onClick={dict.clearProblem}>🎙️ {dictationHelp(dict.problem)}</div>
      )}
    </div>
  );
}

/** 입력창이 말을 보낼 곳. 기본은 맥스이고, 일꾼을 고르면 그 일꾼에게 간다. */
function RecipientChip() {
  const worker = useOffice((s) => { const id = recipientOf(s); return id === 'chef' ? undefined : s.agents[id]; });
  const color = ROLES[worker?.role ?? 'chef'].color;
  const clear = () => { sfx('click'); useOffice.setState({ recipient: null }); };
  return (
    <div className="recipient">
      <span className="recipient-label">받는 사람</span>
      <span className={`recipient-chip ${worker ? 'worker' : ''}`} style={{ ['--c' as string]: color }} data-to={worker?.id ?? 'chef'}>
        <i />{worker ? worker.name : '맥스'}
        {worker && <button className="recipient-clear" aria-label="맥스에게 보내기로 되돌리기" title="맥스에게 보내기로 되돌리기" onClick={clear}>×</button>}
      </span>
      {worker && <button className="recipient-back" onClick={clear}>맥스에게</button>}
    </div>
  );
}
