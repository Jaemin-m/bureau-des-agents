// 사무실 위에 뜨는 창들: 최종 결과 카드, 파일 보기, 지난 미션,
// 설정, 그리고 작은 알림.
import { useEffect, useMemo, useState } from 'react';
import { sfx } from '../audio/sfx.ts';
import { savePref, useOffice } from '../state/store.ts';
import { applySound } from '../audio/sound.ts';
import { FileList } from './Panel.tsx';
import { fmtDate, fmtDuration, plural, tilde } from './format.ts';
import { mdToHtml } from './md.ts';
import { tidy } from './tidy.ts';

/** 미션 완료: 맥스가 팀이 한 일을 보여 준다. */
export function FinalCard() {
  const show = useOffice((s) => s.showFinal);
  const final = useOffice((s) => s.final);
  const mission = useOffice((s) => s.mission);
  const stats = useOffice((s) => s.stats);
  const workMs = useOffice((s) => s.workMs);
  const files = useOffice((s) => s.files.length);
  const send = useOffice((s) => s.send);
  const replaying = useOffice((s) => s.replaying);
  const html = useMemo(() => (final?.text ? mdToHtml(tidy(final.text)) : ''), [final?.text]);
  if (!show || !final || !mission) return null;
  const close = () => useOffice.setState({ showFinal: false });
  return (
    <div className="final" role="dialog" aria-label="미션 결과">
      <button className="close" onClick={close} aria-label="닫기">×</button>
      <div className="final-head">
        <span className="final-badge"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
        <div>
          <b>미션 완료</b>
          <span>{mission.title} · {fmtDuration(workMs)}</span>
        </div>
      </div>
      <div className="final-stats">
        <span>🤖 에이전트 {plural(stats.agents, '명')}</span>
        <span>🔎 검색 {plural(stats.searches, '번')}</span>
        <span>🌐 읽은 페이지 {plural(stats.pages, '개')}</span>
        <span>📄 결과물 {plural(files, '개')}</span>
      </div>
      {html && <div className="md final-text" dangerouslySetInnerHTML={{ __html: html }} />}
      {files > 0 && <FileList />}
      {!replaying && (
        <div className="final-actions">
          <button className="btn" onClick={() => send({ t: 'open', missionId: mission.id })}>폴더 열기</button>
          <button className="btn" onClick={() => { close(); useOffice.setState({ draft: ' ' }); }}>수정 요청</button>
          <button className="btn primary" onClick={() => { sfx('click'); close(); send({ t: 'new' }); }}>새 미션</button>
        </div>
      )}
    </div>
  );
}

/** 사무실을 떠나지 않고 결과물(보고서, 표…)을 읽는다. */
export function Viewer() {
  const viewer = useOffice((s) => s.viewer);
  const send = useOffice((s) => s.send);
  const agents = useOffice((s) => s.agents);
  const versions = useOffice((s) => (s.viewer ? s.versions[`${s.viewer.missionId}|${s.viewer.file}`] : undefined));
  const html = useMemo(() => {
    if (!viewer?.text) return '';
    const ext = viewer.file.split('.').pop()?.toLowerCase() ?? '';
    if (ext === 'md' || ext === 'markdown') return mdToHtml(viewer.text);
    if (['html', 'htm', 'css', 'js', 'ts', 'py', 'json', 'svg'].includes(ext)) return '';
    if (ext === 'csv') {
      const sep = viewer.text.includes(';') && !viewer.text.split('\n')[0].includes(',') ? ';' : ',';
      const rows = viewer.text.trim().split('\n').slice(0, 200).map((r) => r.split(sep));
      const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!).replace(/^"|"$/g, '');
      return `<table>${rows.map((r, i) => `<tr>${r.map((c) => (i === 0 ? `<th>${esc(c)}</th>` : `<td>${esc(c)}</td>`)).join('')}</tr>`).join('')}</table>`;
    }
    return '';
  }, [viewer]);
  if (!viewer) return null;
  const close = () => useOffice.setState({ viewer: null });
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal viewer" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>{viewer.file}</b>
          <div className="row">
            {versions && versions.length > 1 && (
              <select
                className="versions"
                title="이 파일의 버전 기록"
                value={viewer.version ?? ''}
                onChange={(e) => {
                  const v = e.target.value || undefined;
                  useOffice.setState({ viewer: { ...viewer, text: undefined, version: v } });
                  send({ t: 'read', missionId: viewer.missionId, file: viewer.file, version: v });
                }}
              >
                <option value="">현재 버전</option>
                {versions.slice(1).map((v, i) => (
                  <option key={v.id} value={v.id}>
                    v{versions.length - 1 - i} · {new Date(v.at).toLocaleString('ko-KR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })} · {v.by === 'chef' ? '맥스' : agents[v.by]?.name ?? '팀'}
                  </option>
                ))}
              </select>
            )}
            <button className="btn small" onClick={() => send({ t: 'open', missionId: viewer.missionId, file: viewer.file })}>앱으로 열기</button>
            <button className="close" onClick={close} aria-label="닫기">×</button>
          </div>
        </div>
        <div className="modal-body">
          {viewer.text === undefined ? <p className="muted">여는 중…</p>
            : html ? <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
              : <pre className="plain">{viewer.text}</pre>}
          {viewer.truncated && <p className="small muted">(긴 파일이라 앞부분만 보여요.)</p>}
        </div>
      </div>
    </div>
  );
}

/** 지난 미션: 다시 재생하거나(촬영용) 폴더를 열 수 있다. */
export function History() {
  const open = useOffice((s) => s.historyOpen);
  const missions = useOffice((s) => s.missions);
  const send = useOffice((s) => s.send);
  const connection = useOffice((s) => s.connection);
  if (!open) return null;
  const close = () => useOffice.setState({ historyOpen: false });
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal history" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><b>지난 미션</b><button className="close" onClick={close} aria-label="닫기">×</button></div>
        <div className="modal-body">
          {connection !== 'live' && <p className="muted">지난 미션을 보려면 사무실을 Claude Code에 연결하세요(npm start).</p>}
          {connection === 'live' && !missions.length && <p className="muted">아직 미션이 없어요. 첫 미션은 화면 아래에서 시작할 수 있어요.</p>}
          {missions.map((m) => (
            <div key={m.id} className="hist">
              <div className="hist-id">
                <b>{m.title}</b>
                <span className="small muted">
                  {fmtDate(m.createdAt)} · {fmtDuration(m.workMs)} · 에이전트 {plural(m.stats.agents, '명')} · 결과물 {plural(m.files.length, '개')}
                  {m.status === 'working' ? ' · 진행 중' : m.status === 'done' ? '' : m.status === 'stopped' ? ' · 중단됨' : ' · 오류'}
                </span>
              </div>
              <div className="row">
                <button className="btn small" title="팀을 다시 부르지 않고 미션을 다시 재생해요. 촬영할 때 좋아요" onClick={() => { sfx('click'); close(); send({ t: 'replay', missionId: m.id }); }}>▶ 다시 재생</button>
                <button className="btn small ghost" onClick={() => send({ t: 'open', missionId: m.id })}>폴더</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const CHEF_MODELS: [string, string][] = [['sonnet', 'Sonnet (빠름, 추천)'], ['opus', 'Opus (가장 섬세함)'], ['fable', 'Fable'], ['haiku', 'Haiku (번개처럼 빠름)'], ['', 'Claude Code 기본 모델']];
const TEAM_MODELS: [string, string][] = [['sonnet', 'Sonnet (빠름, 추천)'], ['haiku', 'Haiku (아주 빠름, 절약형)'], ['opus', 'Opus (가장 섬세함)'], ['fable', 'Fable'], ['inherit', '맥스와 같은 모델']];

/** Codex 모델 이름은 목록이 자주 바뀌어서 직접 적는다. 비우면 Codex의 기본 모델이다. 입력을 마칠 때(포커스를 옮기거나 Enter) 저장한다. */
function CodexModelField() {
  const saved = useOffice((s) => s.settings.codexModel ?? '');
  const send = useOffice((s) => s.send);
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);
  const commit = () => { if (draft.trim() !== saved) send({ t: 'settings', settings: { codexModel: draft.trim() } }); };
  return (
    <label className="field">
      <span>Codex 일꾼의 두뇌</span>
      <input
        type="text" value={draft} placeholder="비워 두면 Codex 기본 모델" spellCheck={false} autoComplete="off" maxLength={64}
        onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
      />
      <small className="muted">Codex가 알아듣는 모델 이름을 적어요(예: gpt-5). 모르면 비워 두세요.</small>
    </label>
  );
}

export function SettingsPanel() {
  const open = useOffice((s) => s.settingsOpen);
  const settings = useOffice((s) => s.settings);
  const send = useOffice((s) => s.send);
  const claude = useOffice((s) => s.claude);
  const hasCodex = useOffice((s) => s.installed.some((a) => a.kind === 'codex' && a.found));
  const dir = useOffice((s) => s.dir);
  const voiceOn = useOffice((s) => s.voiceOn);
  const cameraAuto = useOffice((s) => s.cameraAuto);
  if (!open) return null;
  const close = () => useOffice.setState({ settingsOpen: false });
  return (
    <div className="modal-back" onClick={close}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head"><b>사무실 설정</b><button className="close" onClick={close} aria-label="닫기">×</button></div>
        <div className="modal-body">
          <label className="field">
            <span>맥스(팀장)의 두뇌</span>
            <select value={settings.chefModel} onChange={(e) => send({ t: 'settings', settings: { chefModel: e.target.value } })}>
              {CHEF_MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field">
            <span>팀의 두뇌</span>
            <select value={settings.teamModel} onChange={(e) => send({ t: 'settings', settings: { teamModel: e.target.value } })}>
              {TEAM_MODELS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {hasCodex && <CodexModelField />}
          <div className="field">
            <span>허락</span>
            <label className="radio"><input type="radio" checked={settings.permission === 'auto'} onChange={() => send({ t: 'settings', settings: { permission: 'auto' } })} /> 팀이 알아서 하고, 위험한 작업만 물어봐요</label>
            <label className="radio"><input type="radio" checked={settings.permission === 'ask'} onChange={() => send({ t: 'settings', settings: { permission: 'ask' } })} /> 명령을 실행할 때마다 물어봐요</label>
          </div>
          <div className="field">
            <span>연출</span>
            <label className="radio"><input type="checkbox" checked={voiceOn} onChange={(e) => { useOffice.setState({ voiceOn: e.target.checked }); savePref('voice', e.target.checked); applySound(useOffice.getState().sound); }} /> 맥스의 목소리: 브라우저 음성(TTS)으로 읽어요(“시작해요!”, “미션 완료!”, 사무실 둘러보기)</label>
            <label className="radio"><input type="checkbox" checked={cameraAuto} onChange={(e) => { useOffice.setState({ cameraAuto: e.target.checked }); savePref('cameraAuto', e.target.checked); }} /> 촬영 모드에서 카메라가 알아서 작업을 따라가요</label>
          </div>
          <p className="small muted">설정은 다음 미션부터 적용돼요. 팀은 미션 폴더 안에서만 일하고, 사무실 밖에서는 묻지 않고 아무것도 실행하지 않아요.</p>
          {claude?.found && <p className="small muted">Claude Code {claude.version} · {tilde(dir)}</p>}
          <div className="keys">
            <b>단축키</b>
            <span><kbd>V</kbd> 세로 화면(릴스)</span>
            <span><kbd>F</kbd> 촬영 모드</span>
            <span><kbd>C</kbd> 자동 카메라</span>
            <span><kbd>T</kbd> 사무실 둘러보기</span>
            <span><kbd>J</kbd> 주크박스</span>
            <span><kbd>N</kbd> 낮, 저녁, 밤</span>
            <span><kbd>M</kbd> 소리</span>
            <span><kbd>H</kbd> 지난 미션</span>
            <span><kbd>Esc</kbd> 닫기, 촬영 모드 끝내기</span>
            <span>🥚 비밀 코드가 있어요… (옛날 게임을 떠올려 보세요)</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useOffice((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  );
}
