// 열린 요청 쌓기: 도구 허락(허락/거절)과 일꾼의 질문(선택지, 짧은 답)은 다른 일이라 다르게 보인다.
// 화면 아래 AskBar와 일꾼 카드가 같은 AskCard를 쓴다.
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ROLES } from '../../shared/activity.ts';
import { sfx } from '../audio/sfx.ts';
import { openAsks, useOffice, type AskView } from '../state/store.ts';

export function AskCard({ ask }: { ask: AskView }) {
  const agents = useOffice((s) => s.agents);
  const send = useOffice((s) => s.send);
  const [text, setText] = useState('');
  const worker = ask.who === 'chef' ? null : agents[ask.who];
  const who = worker ? worker.name : '맥스';
  const color = ROLES[worker?.role ?? 'chef'].color;

  if (ask.kind === 'question') {
    const reply = (t: string) => {
      const v = t.trim();
      if (!v) return;
      sfx('yes');
      send({ t: 'reply', requestId: ask.requestId, text: v });
      setText('');
    };
    return (
      <div className="ask-card question" data-request={ask.requestId}>
        <div className="askbar-head">💬 <b style={{ color }}>{who}</b>의 질문</div>
        <div className="askbar-label">{ask.label}</div>
        {ask.detail && <p className="askbar-note">{ask.detail}</p>}
        {ask.options && ask.options.length > 0 && (
          <div className="ask-options">
            {ask.options.map((o) => <button key={o} className="btn small" onClick={() => reply(o)}>{o}</button>)}
          </div>
        )}
        <div className="ask-reply">
          <input
            value={text}
            placeholder={ask.options?.length ? '직접 답하려면 여기에 적어요' : '답을 적어 주세요'}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); reply(text); } }}
          />
          <button className="btn primary small" disabled={!text.trim()} onClick={() => reply(text)}>답하기</button>
        </div>
      </div>
    );
  }

  const answer = (allow: boolean) => { sfx(allow ? 'yes' : 'no'); send({ t: 'answer', requestId: ask.requestId, allow }); };
  return (
    <div className="ask-card approval" data-request={ask.requestId}>
      <div className="askbar-head">🙋 <b style={{ color }}>{who}</b>의 허락 요청</div>
      <div className="askbar-label">{ask.label}</div>
      {!ask.full && ask.detail && <pre className="askbar-detail">{ask.detail}</pre>}
      <div className="askbar-actions">
        <button className="btn primary" onClick={() => answer(true)}>허락</button>
        <button className="btn" onClick={() => answer(false)}>거절</button>
      </div>
    </div>
  );
}

/** 열린 요청 중 먼저 온 하나만 펼치고, 나머지는 “외 N건”으로 접어 둔다(사무실이 가려지지 않게). */
export function AskBar() {
  const asks = useOffice(useShallow((s) => openAsks(s.asks)));
  const [open, setOpen] = useState(false);
  useEffect(() => { if (asks.length <= 1) setOpen(false); }, [asks.length]);
  if (!asks.length) return null;
  const rest = asks.length - 1;
  const shown = open ? asks : asks.slice(0, 1);
  return (
    <div className="askbar">
      <div className="askbar-stack">
        {shown.map((a) => <AskCard key={a.requestId} ask={a} />)}
      </div>
      {rest > 0 && (
        <button className="askbar-count" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? '접기' : `외 ${rest}건 더 보기`}
        </button>
      )}
    </div>
  );
}
