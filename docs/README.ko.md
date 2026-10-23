# DSH Desk Pet

**DeepSeek Harness를 데스크톱에 올려 두고, 생각하고 일하고 말하는 모습을 눈으로 확인하세요.**

DeepSeek Harness용 데스크톱 펫 플러그인 · 투명한 항상 위 창 · 이벤트 기반 5가지 상태 · 스킨 2종 · DSH와 함께 시작하고 종료

지원 **@deepseek-ai/dsh 0.2.1-rc.2** · Electron 45 · [中文](../README.md) · [English](README.en.md) · [日本語](README.ja.md)

![다섯 가지 상태와 고래 스킨](images/states.png)

---

## 무엇인가

DSH Desk Pet은 내 컴퓨터에서 실행되는 DSH 플러그인입니다. DSH가 시작되면 화면 오른쪽 아래에 작은 창을 띄우고, 세션에서 일어나는 일을 캐릭터의 동작으로 보여 줍니다.

- **진행 상황이 보입니다**: 생각 중, 도구 호출 중, 답변 중마다 동작이 다르고, 도구를 호출하면 명령이나 파일 경로를 말풍선에 표시합니다.
- **바로 물어볼 수 있습니다**: 왼쪽 아래 버튼으로 입력창을 열고 Enter로 보내면 됩니다. 브라우저로 돌아갈 필요가 없습니다.
- **대화는 하나**: 펫은 항상 `desk-pet` 세션을 사용합니다. Web UI에서도 같은 기록이 보이고, 다시 시작해도 자동으로 복원됩니다.
- **오류를 숨기지 않습니다**: 모델 실패, 도구 거부, 턴 차단이 생기면 캐릭터가 떨면서 원인을 표시합니다.

펫에는 자체 커널이 없습니다. 모델 설정, 세션 저장, 권한 정책은 모두 펫을 띄운 DSH 프로세스의 것을 사용하며, DSH가 종료되면 펫도 함께 종료됩니다.

## 설계 원칙

| 원칙 | 의미 |
| --- | --- |
| DSH에 묶여 있음 | DSH 플러그인으로만 실행되며, 별도 커널이나 자체 세션 저장소를 두지 않습니다. Electron을 직접 실행하면 오류를 내고 종료합니다 |
| 상태에는 근거가 있음 | 모든 동작이 DSH 세션 이벤트 하나에 대응합니다. 무작위로 재생하거나 타이머로 추측하지 않습니다 |
| 오류는 분명하게 | Electron을 찾지 못함, 세션 복원 실패, 잘못된 스킨 설정은 모두 오류로 처리하며, 조용히 기본값으로 바꾸지 않습니다 |
| 렌더러에는 권한이 없음 | 페이지가 쓸 수 있는 것은 IPC 메서드 4개뿐입니다. `contextIsolation`과 CSP를 켜고, Node나 네트워크에 접근하지 않습니다 |

## 설치

프로젝트 디렉터리에서 실행합니다.

```sh
npm install                       # 프로젝트에 포함된 DSH와 Electron 설치, 전역 dsh 불필요
npm start                         # dsh web --patch cordis.patch.yml 과 동일
```

브라우저에서 `http://127.0.0.1:3080/`을 열면 화면 오른쪽 아래에 펫이 함께 나타납니다. 추가 인자는 그대로 전달됩니다(예: `npm start -- --no-open`).

### 평소 쓰는 프로필에 추가

평소의 `dsh web`에서도 펫을 띄우려면 `cordis.patch.yml`의 `insert` 블록을 `$DSH_HOME/profiles/web/cordis.patch.yml`에 덧붙이고, 플러그인 경로를 내 컴퓨터의 절대 경로로 바꿉니다.

### 설치가 건드리지 않는 것

- `npm start`는 `--patch`로 플러그인을 임시로 덧씌울 뿐이며, `$DSH_HOME` 아래의 프로필 파일은 **수정하지 않습니다**.
- 플러그인은 `desk-pet` 세션의 이벤트만 구독하며, 다른 세션의 내용은 **읽지 않습니다**.
- 펫 프로세스는 DSH의 `ctx.subprocess`가 관리합니다. DSH가 종료되거나 플러그인이 언로드되면 종료·회수되어 백그라운드에 남지 않습니다.
- 셸에 `NODE_ENV=production`이 설정되어 있으면 npm이 devDependencies를 건너뜁니다. 그래서 Electron은 `dependencies`에 두었고, 설치 직후 바로 쓸 수 있습니다.

## 조작

| 조작 | 결과 |
| --- | --- |
| 캐릭터 드래그 | 창 이동 |
| 왼쪽 아래 버튼 | 입력창 열기 / 닫기, Enter로 전송, `Esc`로 닫기 |
| 우클릭 | 메뉴: 항상 위 전환, DSH 데이터 디렉터리 열기, 종료 |
| 오른쪽 아래 버튼 | 펫 닫기(DSH는 계속 실행) |
| Web UI에서 `/pet` 입력 | 닫은 펫을 다시 열기. 이미 열려 있으면 맨 앞으로 가져오기 |

## 상태는 어디서 오는가

| 캐릭터 | 동작(avatar 스킨) | DSH 이벤트 |
| --- | --- | --- |
| 대기 | 고개를 살짝 흔듦 | 이벤트 없음 |
| 생각 | 고개를 갸웃, 머리 위에서 점이 튐 | `turn/start`, `step/start`, `agent/status=running` |
| 작업 | 빠르게 끄덕임, 톱니바퀴 회전, 말풍선에 명령 | `tool/call` |
| 말하기 | 통통 튀며, 말풍선에 답변을 타자 치듯 표시 | `assistant/message` |
| 오류 | 떨고 회색으로 변하며 땀방울, 말풍선에 원인 | `tool/result`의 `message.isError`, `turn/end`의 `reason.kind`가 `error` / `blocked` |

## 설정

`cordis.patch.yml`의 플러그인 항목 아래에 `config`를 추가합니다.

```yaml
- insert:
    - id: desk-pet
      name: /path/to/dsh-native-bot/plugin/desk-pet.mjs
      config:
        skin: whale
```

| 항목 | 기본값 | 역할 |
| --- | --- | --- |
| `skin` | `avatar` | `avatar`(비트맵 얼굴, 전체가 움직임) 또는 `whale`(손으로 그린 SVG, 부위별로 움직임). 잘못된 값은 오류 |
| `sessionId` | `desk-pet` | 펫이 사용하는 세션 id |
| `title` | `桌宠` | Web UI 사이드바에 표시되는 세션 제목. Web UI에서 직접 바꾼 이름이 있으면 그것을 우선 |
| `cwd` | DSH의 작업 디렉터리 | 새 세션을 만들 때의 작업 디렉터리 |
| `projectDir` | 플러그인이 있는 저장소 | 펫 프런트엔드가 있는 디렉터리 |
| `electron` | 프로젝트 의존성의 Electron | Electron 실행 파일 경로 |

펫은 DSH에 연결되면 세션을 열고, 세션 작업 디렉터리와 같은 워크스페이스에 넣습니다(없으면 자동 등록). Web UI 사이드바에서 바로 찾아 브라우저에서 대화를 이어갈 수 있습니다.

## 모습 바꾸기

- **`avatar`**: `src/renderer/avatar.png`. 배경은 투명, 내용 경계에 맞춰 자르고 폭은 640px 안팎. 이 파일만 바꾸면 되고 동작은 고칠 필요가 없습니다.
- **`whale`**: `src/renderer/index.html` 안의 `<svg>`. 그라데이션과 CSS 키프레임으로 움직이며 이미지 소재를 쓰지 않습니다.
- 비트맵은 전체로만 움직일 수 있습니다. 눈 깜빡임이나 입 모양 변화에는 같은 캐릭터의 눈 감은 그림과 입 다문 그림이 필요합니다.
- 다른 사람의 작품을 쓰는 것은 개인 용도라면 괜찮지만, 공개하기 전에 사용 권한을 확인하세요.

## 호환성

| 구성 요소 | 값 |
| --- | --- |
| DSH | `@deepseek-ai/dsh` 0.2.1-rc.2, 프로젝트 의존성으로 설치 |
| Electron | 45.x, UI 전용이며 DSH 커널은 실행하지 않음 |
| Node | ≥20.11, DSH 실행용 |
| OS | macOS에서 검증. Windows / Linux는 미검증 |

## 문제가 생기면

```sh
npm test                                      # 문법 검사 + 단위 테스트, DSH 실행 불필요
npm run test:e2e                              # 실제 Electron 통합 테스트: 닫기 -> /pet -> 다시 표시, 펫이 잠깐 화면에 나타남
DSH_PET_SELFTEST=1 npm start -- --no-open     # 종단 간 자체 점검: 별도 세션 desk-pet-selftest로 한 문장을 보내고 /tmp/pet-selftest.png 저장 후 종료
DSH_PET_SHOT=/tmp/pet.png DSH_PET_SHOT_STATE=talking ./node_modules/.bin/electron .
                                              # 렌더링만 확인, DSH에 연결하지 않음. 상태: thinking / working / talking / error
```

플러그인과 펫의 진단 메시지는 `[desk-pet]`으로 시작하며, DSH를 실행한 터미널에 출력됩니다. 3080이 열리지 않으면 먼저 `dsh web`이 실제로 실행 중인지 확인하세요. `--patch`는 반드시 `web` 바로 뒤에 와야 합니다.

## 알려진 제한

- 말풍선의 타자 효과는 로컬 연출이며, 플러그인은 아직 토큰 단위의 `agent/assistant-stream`을 받지 않습니다.
- 승인이 필요한 도구 호출은 펫에서 승인 창을 띄우지 않고 DSH 정책을 따릅니다. Web UI에서 승인할 수 있습니다.
- 창은 주 모니터에 고정되며, 모니터를 넘나들며 따라가지 않습니다.
- 애니메이션은 CSS 키프레임뿐이며, 본이나 프레임 시퀀스는 없습니다.

## 구조

```
plugin/desk-pet.mjs     DSH 측 플러그인: 펫 실행, 이벤트 전달, prompt 전달, 프로세스 회수
cordis.patch.yml        플러그인을 프로필에 넣는 오버레이
src/main.mjs            Electron 메인 프로세스: 창, 메뉴, IPC, 실행 가드
src/stdio-kernel.mjs    플러그인과의 통로: stdin/stdout로 한 줄에 JSON 하나, stdout은 프로토콜 전용
src/state.mjs           세션 이벤트 -> 캐릭터 상태(순수 함수)
src/preload.cjs         렌더러에 공개하는 유일한 창구
src/renderer/           모습, 애니메이션, 말풍선
```

```sh
npm run check           # 전체 소스 문법 검사
```

키워드: DeepSeek Harness · DSH 플러그인 · 데스크톱 펫 · desktop pet · Electron · 투명 창 · 세션 이벤트 · 상태 머신
