// 세로 화면(릴스 촬영용)에서 사무실 아래에 놓이는 줄: 맥스의 계획과 팀원 목록을
// 휴대폰에서도 크게 읽히도록 보여 준다.
import { useShallow } from 'zustand/react/shallow';
import { ROLES } from '../../shared/activity.ts';
import { teamList, useOffice } from '../state/store.ts';
import { Avatar } from './Panel.tsx';

export function Strips() {
  const plan = useOffice((s) => s.plan);
  const team = useOffice(useShallow(teamList));
  const mission = useOffice((s) => s.mission);
  if (!mission) {
    return (
      <div className="strips">
        <div className="legend">
          {(['recherche', 'code', 'design', 'redaction', 'analyse'] as const).map((r) => (
            <span key={r} style={{ ['--c' as string]: ROLES[r].color }}>{ROLES[r].icon} {ROLES[r].label}</span>
          ))}
        </div>
      </div>
    );
  }
  const done = plan.filter((p) => p.status === 'completed').length;
  return (
    <div className="strips">
      {plan.length > 0 && (
        <div className="strip-plan">
          <b>계획 <span>{done}/{plan.length}</span></b>
          <ul>{plan.slice(0, 4).map((p, i) => <li key={i} className={p.status}><i />{p.text}</li>)}</ul>
        </div>
      )}
      {team.length > 0 && (
        <div className="strip-team">
          {team.slice(-12).map((a) => (
            <span key={a.id} className={`mate ${a.status}`} style={{ ['--c' as string]: ROLES[a.role].color }}>
              <Avatar role={a.role} size={18} />
              {a.name}
              {a.status === 'done' ? ' ✓' : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
