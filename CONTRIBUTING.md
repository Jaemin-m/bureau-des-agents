# 에이전트 사무실 함께 고치기

도와주려고 해서 고마워요! 이 프로젝트는 쓰는 사람과 함께, 처음 시작하는 사람까지 함께 자라도록 만들었어요.

> 이 저장소는 [Le Bureau des agents](https://github.com/devlikemasta/bureau-des-agents)(VibesMoney, MIT)의 한국어 포크예요.
> 여기서 고친 내용은 원 저장소에 자동으로 반영되지 않아요.

## 아이디어가 있거나 버그를 찾았다면

**Issue**를 열어 주세요(GitHub 페이지 위쪽의 "Issues" 탭, 그다음 "New issue"). 맞는 양식을 고르세요:
"버그" 또는 "아이디어". 본 것, 또는 보고 싶은 것을 적어 주세요. 스크린샷이 있으면 큰 도움이 돼요.

이야기를 나누거나, 내 사무실을 자랑하거나, 도움을 구하고 싶다면 **Discussions** 탭도 있어요.

## 개선을 제안하고 싶다면

GitHub의 기본 순서, 다섯 단계예요.

1. **Fork**: 오른쪽 위 "Fork" 버튼. 프로젝트의 내 복사본이 생겨요.
2. 아이디어마다 **브랜치** 하나: `git checkout -b new-furniture` (하는 일을 짧게 나타내는 이름).
3. **변경**한 뒤, 다 잘 되는지 확인해요.
   ```bash
   npm install
   npm run check    # 타입 검사
   npm run build    # 사무실 빌드
   npm start        # 그리고 브라우저에서 결과 확인
   ```
4. 내 브랜치에 **commit**하고 **push**해요.
5. **Pull request**: GitHub에서 "Compare & pull request". 무엇이 바뀌는지, 눈에 보이는 거라면 스크린샷과 함께 설명해 주세요.

함께 읽어 보고, 필요하면 이야기 나눈 뒤 `main`에 합쳐요.

### 가장 쉬운 방법: Claude Code에게 부탁하기

사무실 폴더에서 Claude Code를 열고, 예를 들어 이렇게 말하세요.

> 에이전트 사무실의 소파 구석에 클릭할 수 있는 팝콘 기계를 추가하고, GitHub에 pull request로 올려 줘.

[CLAUDE.md](CLAUDE.md) 파일이 프로젝트가 어떻게 만들어졌고 어떤 규칙을 따르는지 Claude Code에게 알려 줘요.

## 시작하기 좋은 아이디어

- **새 가구나 새 깜짝 요소** (전부 코드로 그려요, `src/engine/furniture.ts`).
- **팀의 새 직무** (`server/team.ts`와 `shared/activity.ts`).
- **Windows나 Linux에서 테스트**하고 막히는 곳 알려 주기.
- **주크박스의 새 곡** (공유할 권리가 있는 곡만요. 출처를 알려 주세요).
- **맥스의 한국어 목소리 녹음**: 지금은 브라우저 음성 합성으로 읽어요. 공유할 수 있는 녹음이 있다면 출처와 함께 제안해 주세요.

## 사무실 규칙

- **인터페이스는 한국어, 친근한 해요체로 말해요.** 짧은 문장, 쉬운 말: 사무실은 처음 시작하는 사람을 위한 거예요.
- **화면에 전체 경로나 사용자 이름을 절대 보여 주지 않아요** (`src/ui/`의 `tidy()`와 `tilde()`를 써요).
- **사무실은 가볍게**: 한 장면에 약 1밀리초, 무거운 3D 금지, 탭이 숨겨지면 아무것도 안 그려요.
- **보안이 먼저**: 서버는 127.0.0.1에서만 연결을 받고, 팀은 제한 모드를 유지하고, 팀이 만든 사이트는 샌드박스 안에 있어요.
- **픽셀 아트는 코드로 그려요**: 사무실 안에 외부 이미지는 없어요.

## 버전

- `main`은 언제나 잘 돌아가는 버전이에요.
- 새 버전마다 번호(`v0.2.0`…)를 붙이고, 바뀐 점을 [CHANGELOG.md](CHANGELOG.md)에 적고, GitHub에 "Release"를 만들어요.

---

**In English:** this is a Korean fork of Le Bureau des agents. Open an issue for bugs and ideas, or fork, create a branch, run
`npm run check` and `npm run build`, and open a pull request. The UI is in Korean.
