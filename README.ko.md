<h1 align="center">Multi-Workspace for Notion</h1>

<p align="center"><em>Claude Code 하나로 모든 Notion 워크스페이스를. 공식 도구는 그대로.</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.1-111111?style=flat-square" alt="Version 0.4.1">
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-111111?style=flat-square" alt="Claude Code plugin">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-111111?style=flat-square" alt="macOS, Windows, Linux">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center"><sub><a href="README.md">English</a> &middot; <a href="README.ko.md">한국어</a></sub></p>

---

Claude Code에서 여러 Notion 워크스페이스를 동시에 쓸 수 있게 해 줍니다. 공식 Notion MCP 서버의 도구를 하나도 빠짐없이 그대로 씁니다.

> **상태: 개발 초기 (v0.4.1).** 워크스페이스 연결과 공식 도구 전달은 동작하며, 실제 워크스페이스를 macOS와 Windows의 Claude Code(터미널, VS Code 확장)와 Claude Desktop에 연결해 시험했습니다. Linux는 CI에서 실제 GNOME Keyring과 `zenity`로 시험합니다. 계획한 기능 중 아직 없는 것이 여럿 있습니다. [로드맵](#로드맵)과 [알려진 제약](#알려진-제약)을 참고하세요.
>
> 비공식 프로젝트입니다. Notion Labs, Inc.와 관계가 없고 Notion의 승인을 받지 않았습니다.

## 왜 만들었나

Notion 공식 MCP 커넥터는 연결 하나에 워크스페이스 하나만 붙습니다. 다른 워크스페이스를 쓰려면 연결을 끊고 다시 로그인해야 하고, 그동안 다른 대화에도 영향을 줍니다. claude.ai는 같은 URL(`https://mcp.notion.com/mcp`)로 커넥터를 하나 더 추가하는 것도 막습니다.

Claude Code에서는 같은 URL을 이름만 다르게 두 번 등록할 수 있습니다. 하지만 이런 문제가 있습니다.

- 연결마다 도구 전체(약 65개)가 복제됩니다. 워크스페이스가 2개면 약 130개, 3개면 약 195개가 됩니다.
- 연결마다 이름을 직접 붙여야 하고, Notion 로그인 화면에서 실제로 어느 워크스페이스를 골랐는지는 아무도 확인하지 않습니다. 그래서 `notion-work`라고 이름 붙인 연결이 개인 워크스페이스를 가리키고 있어도 모르고 지나갈 수 있습니다.
- 모든 워크스페이스를 한 번에 검색하는 것처럼 워크스페이스를 넘나드는 기능이 없습니다.

다른 오픈소스 프로젝트들은 Notion REST API를 직접 호출하고, 직접 만든 도구 몇 개만 제공합니다. 이 프로젝트는 공식 호스팅 서버 앞에 서서 공식 도구를 그대로 넘겨주므로, Notion이 도구를 바꾸면 자동으로 따라갑니다.

## 동작 방식

```
Claude Code
    │  stdio (Claude가 서버를 자식 프로세스로 실행)
    ▼
Multi-Workspace for Notion  (로컬 Node 프로세스)
    │  호출마다 workspace 값을 보고 보낼 곳을 고름
    ├──▶ mcp.notion.com   [My Notion]
    ├──▶ mcp.notion.com   [회사]
    └──▶ mcp.notion.com   [...]
```

- **워크스페이스마다 OAuth 클라이언트 하나.** 워크스페이스를 연결하면 서버가 Notion MCP 서버에 클라이언트로 등록하고(Dynamic Client Registration), PKCE로 로그인하고, 임시 `localhost` 포트로 인증 결과를 받습니다.
- **고른 워크스페이스를 확인합니다.** 로그인 직후 `notion-get-self`를 호출해 실제 워크스페이스 이름과 ID를 기록합니다. 이미 연결된 워크스페이스를 또 고르면 거부합니다.
- **공식 도구를 한 번만 노출합니다.** 도구마다 필수 파라미터 `workspace` 하나가 더 붙습니다. 이 파라미터에 넣을 수 있는 값은 그 도구가 있는 워크스페이스뿐이라, 요금제에 따라 없는 도구가 엉뚱한 워크스페이스로 가지 않습니다. 그 밖의 호출 내용과 결과는 손대지 않고 그대로 전달합니다.
- **Notion의 이름을 그대로 씁니다.** 워크스페이스는 로그인 직후 받아 온 Notion에서의 이름으로 불립니다. 따로 이름을 지을 필요가 없고, 이름과 실제 워크스페이스가 어긋날 일도 없습니다. 연결된 워크스페이스 두 개의 이름이 같으면, 뒤에 연결한 쪽에 `My Notion (1a2b3c4d)`처럼 ID 앞부분이 붙습니다.
- **연결된 워크스페이스를 Claude에게 알려 줍니다.** 서버 안내문(instructions)에 각 워크스페이스의 이름과 설명을 넣습니다. 워크스페이스가 불분명하면 쓰기 전에 사용자에게 물으라는 내용도 넣고, 그 뒤에 Notion 공식 안내문을 붙입니다.

Claude가 보내는 호출은 이런 모양입니다.

```json
{ "name": "notion-search", "arguments": { "workspace": "회사", "query": "roadmap" } }
```

## 필요한 것

- macOS, Windows, Linux. 토큰은 OS 보관함에만 저장하고 평문으로는 저장하지 않습니다.
  - macOS: 내장 `security` 명령으로 키체인에 저장
  - Windows: 내장 PowerShell로 DPAPI 암호화한 파일에 저장 (그 Windows 계정만 풀 수 있음)
  - Linux: `secret-tool`로 Secret Service(GNOME Keyring, KWallet)에 저장. `libsecret-tools`(Debian/Ubuntu) 또는 `libsecret`(Fedora/Arch) 설치 필요
- Node.js 20 이상
- Claude Code

## Claude Code 플러그인으로 설치 (추천)

이 저장소는 Claude Code 플러그인 마켓플레이스입니다. 플러그인에 MCP 서버가 파일 하나로 묶여 들어 있어서 따로 빌드할 필요가 없습니다.

```bash
claude plugin marketplace add heoeunseo08/multi-workspace-for-notion
claude plugin install multi-workspace@multi-workspace-for-notion
```

Claude Code 세션을 새로 연 뒤 워크스페이스마다 연결합니다.

```
/multi-workspace:workspace-add 개인 메모
/multi-workspace:workspace-add 회사 위키
```

브라우저에 Notion 로그인 화면이 열리면, 연결할 워크스페이스를 골라 승인하세요. 그 워크스페이스는 Notion에서의 이름으로 불립니다. 브라우저가 안 열렸을 때를 위해 Claude가 로그인 링크도 보여 줍니다. 승인했다고 Claude에게 말하면 실제로 연결된 워크스페이스를 알려 줍니다. 의도한 워크스페이스가 아니면 지우고 다시 추가하세요. 새 워크스페이스는 같은 대화에서 바로 쓸 수 있습니다.

- 설명은 넣지 않아도 됩니다. Claude가 이 설명을 보고 워크스페이스를 고르므로, 그 워크스페이스에 무엇이 있는지 몇 마디 적어 두면 도움이 됩니다.
- 로그인은 최대 10분까지 기다립니다.
- 별칭을 직접 붙이던 0.1.x에서 올라오면, 처음 시작할 때 기존 연결이 Notion 워크스페이스 이름으로 자동으로 바뀝니다. 다시 로그인할 필요는 없습니다.

claude.ai Notion 커넥터도 켜져 있으면 Claude에게 Notion 도구가 두 벌 보입니다. 이 플러그인을 쓰는 곳에서는 그 커넥터를 꺼서 Claude가 헷갈리지 않게 하세요.

그다음에는 평소 말투로 요청하면 됩니다. 예를 들어 "회사 노션과 개인 노션에서 각각 '로드맵'을 검색해 줘"라고 하면, Claude가 워크스페이스 이름과 설명을 보고 `workspace` 값을 고릅니다.

## 스킬

| 스킬 | 하는 일 |
| --- | --- |
| `/multi-workspace:workspace-list` | 연결된 워크스페이스를 실제 이름, 설명, 상태와 함께 보여줍니다. |
| `/multi-workspace:workspace-add [설명]` | 브라우저로 워크스페이스를 연결하고, 실제로 어느 워크스페이스를 골랐는지 보여줍니다. |
| `/multi-workspace:workspace-remove <이름>` | 확인 창에서 승인을 받은 뒤, 이 컴퓨터에서 그 워크스페이스의 토큰과 설정을 지우고 Notion 쪽 토큰도 해제합니다. |
| `/multi-workspace:workspace-check [이름]` | 저장된 토큰으로 다시 로그인해서, 워크스페이스가 아직 동작하는지와 처음 연결한 그 워크스페이스가 맞는지 확인합니다. |
| `/multi-workspace:workspace-help` | 스킬, 도구, 요청 예를 한 화면에 보여줍니다. |

`workspace-add`와 `workspace-remove`는 직접 입력했을 때만 실행됩니다. Claude가 알아서 실행하지 않습니다.

새 세션을 열 때마다 `Notion: My Notion, 회사`처럼 연결 상태가 한 줄로 표시되고, 확인이 필요한 워크스페이스가 있으면 `workspace-check`를 안내합니다.

## Claude Desktop 확장(`.mcpb`)

[최신 릴리스](https://github.com/heoeunseo08/multi-workspace-for-notion/releases/latest)에서 `multi-workspace-for-notion.mcpb`를 받거나, 직접 빌드합니다.

```bash
npm install
npm run pack:mcpb    # multi-workspace-for-notion.mcpb 생성
```

이 파일을 Claude Desktop으로 열어 설치한 뒤, Claude에게 워크스페이스를 연결해 달라고 하면 됩니다(`workspace_connect`). Desktop에는 플러그인 스킬이 없으니 도구를 바로 씁니다.

## 소스에서 설치

코드를 고치거나 플러그인 없이 서버만 쓰고 싶을 때 이 방법을 씁니다.

```bash
git clone https://github.com/heoeunseo08/multi-workspace-for-notion.git
cd multi-workspace-for-notion
npm install
npm run build
node plugin/server.mjs add "개인 메모"
claude mcp add --scope user multi-workspace -- node /absolute/path/to/multi-workspace-for-notion/plugin/server.mjs
```

그다음 `claude mcp list`에서 `multi-workspace`가 연결됐는지 확인하세요.

## CLI 명령

| 명령 | 하는 일 |
| --- | --- |
| `node plugin/server.mjs` | MCP 서버를 stdio로 실행합니다. Claude가 실행하는 명령이라 직접 쓸 일은 없습니다. |
| `node plugin/server.mjs list` | 연결된 워크스페이스 목록을 보여줍니다: 이름, 상태, 설명 |
| `node plugin/server.mjs add [설명...]` | 브라우저 로그인으로 워크스페이스를 연결합니다. |
| `node plugin/server.mjs tools <이름>` | 저장된 토큰으로 붙어서 워크스페이스를 확인하고 도구 목록을 보여줍니다. 연결이 아직 살아 있는지 확인할 때 씁니다. |
| `node plugin/server.mjs remove <이름>` | 먼저 시스템 대화상자로 묻습니다(SSH처럼 대화상자를 띄울 수 없으면 터미널에 워크스페이스 이름을 직접 입력, 파이프 입력은 인정하지 않음). 승인하면 이 컴퓨터에서 토큰과 설정을 지우고 Notion 쪽 토큰도 해제합니다. 질문을 건너뛰는 옵션이 없어서, 셸 도구로 대화 속 확인 창을 우회할 수 없습니다. |

## Claude에게 보이는 도구

| 도구 | 설명 |
| --- | --- |
| 모든 공식 Notion 도구 | 이름, 설명, 옵션은 그대로이고 필수 파라미터 `workspace`가 하나 붙습니다. 읽기 도구가 그 워크스페이스에서 ID를 찾지 못하면 다른 워크스페이스에서 다시 시도하고, 어느 워크스페이스에서 찾았는지 알려 줍니다. 쓰기 도구는 고르지 않은 워크스페이스로 보내지 않습니다. |
| `search_all_workspaces` | 모든 워크스페이스에서 `notion-search`를 동시에 실행하고 결과를 워크스페이스별로 묶어 보여줍니다. 워크스페이스가 둘 이상 연결돼 있을 때만 보입니다. |
| `workspace_list` | 연결된 워크스페이스를 보여줍니다: 이름, ID, 설명, 상태, 연결을 마지막으로 확인한 시각 |
| `workspace_connect` | 워크스페이스 연결을 시작하고 로그인 링크를 바로 돌려줍니다. 다시 부르면 결과를 받습니다(로그인은 최대 10분 기다림). |
| `workspace_disconnect` | 이 컴퓨터에서 워크스페이스의 토큰과 설정을 지우고 Notion 쪽 토큰도 해제합니다. 그 전에 사용자가 직접 확인합니다. 터미널의 Claude Code처럼 클라이언트가 확인 창(MCP elicitation)을 지원하면 그 창으로, 지원하지 않으면(Claude Desktop, VS Code 확장) OS가 띄우는 시스템 대화상자로 묻습니다. macOS는 `osascript`, Windows는 PowerShell 메시지 상자, Linux는 `zenity`나 `kdialog`를 씁니다. 둘 다 Claude가 대신 답할 수 없고, 승인하지 않으면 아무것도 지우지 않습니다. |
| `workspace_check` | 저장된 토큰으로 다시 로그인해서 워크스페이스를 확인하고 상태를 갱신합니다. |

## 데이터 저장 위치

| 무엇 | 어디 |
| --- | --- |
| OAuth 토큰과 클라이언트 등록 정보 | OS 보관함. 서비스 `multi-workspace-for-notion`, 계정 `workspace:<워크스페이스 ID>` (Windows는 설정 폴더의 `credentials/`에 DPAPI로 암호화) |
| 워크스페이스 이름, ID, 설명 | `~/.config/multi-workspace-for-notion/config.json` |
| 도구 목록과 안내문 캐시 | `~/.config/multi-workspace-for-notion/cache/` |
| 토큰 저장용 잠금 파일 | `~/.config/multi-workspace-for-notion/locks/` |

다른 폴더를 쓰려면 `MWN_CONFIG_DIR`을 설정하세요. 본인만 접근할 수 있는 폴더로 지정하세요(기본값은 `0700`으로 만듭니다). 파일은 본인만 읽고 쓸 수 있는 권한으로 만들고, 토큰은 절대 들어가지 않습니다.

## 보안

- 서버는 Claude와 stdio로 통신하고, 평소에는 네트워크 포트를 열지 않습니다.
- 로그인하는 동안에만 인증 결과를 받는 서버가 `127.0.0.1`과 `::1`에서 기다립니다. 응답 하나만 받고, OAuth `state`를 확인한 뒤 바로 닫습니다.
- 토큰은 OS 보관함에만 있습니다. 보관함 도구의 표준 입력으로 넘기므로 프로세스 목록에도 보이지 않습니다.
- 연결 해제는 `workspace_disconnect`든 CLI `remove`든 언제나 Claude가 대신 답할 수 없는 확인 창에서 사용자가 직접 승인해야 합니다. 확인 창이 떠 있는 동안 요청이 취소되거나 Claude가 종료되면 확인 창도 함께 닫히고 아무것도 지우지 않습니다.
- `remove`는 이 컴퓨터의 토큰을 먼저 지운 뒤 Notion 쪽 토큰을 해제합니다(RFC 7009). 오프라인 등으로 해제에 실패하면 결과에 표시되니, 그때는 Notion 설정의 연결(Connections) 메뉴에서 직접 해제하세요.

## 알려진 제약

- **claude.ai 웹과 모바일에서는 쓸 수 없습니다.** 웹과 모바일의 커스텀 커넥터는 원격 URL만 받습니다.
- **Linux는 아직 실제 데스크톱에서 써 보지 않았습니다.** CI와 GNOME Keyring, `zenity`를 넣은 컨테이너에서만 시험했습니다. Linux에서는 Secret Service와 `secret-tool`이 필요하고, Claude Desktop이나 VS Code 확장에서 연결 해제를 확인하려면 `zenity`나 `kdialog`가 필요합니다.
- **이미 열려 있는 다른 세션은 다시 시작해야 바뀐 워크스페이스를 봅니다.** 연결과 해제는 그 작업을 한 세션에서는 바로 반영되지만, 동시에 떠 있는 다른 세션은 다시 시작할 때까지 예전 목록을 씁니다.
- **MCP resources와 prompts는 넘겨주지 않습니다.** Notion의 `notion://docs/...` 문서는 `notion-fetch`로 읽을 수 있고, 서버가 Claude에게 그렇게 하라고 안내합니다.
- **시작할 때 워크스페이스마다 도구 목록을 받습니다**(워크스페이스 2개 기준 약 1초). 15초 안에 받지 못한 워크스페이스는 마지막으로 캐시해 둔 목록을 씁니다.

## 문제 해결

| 문제 | 해결 방법 |
| --- | --- |
| 워크스페이스 추가가 시간 초과로 끝남 | 로그인 화면이 실제로 열렸는지 확인하세요. CLI로 추가할 때는 출력된 주소로 직접 들어가 10분 안에 승인할 수 있습니다. |
| 다른 워크스페이스가 연결됨 | 지우고 다시 추가하면서 Notion 화면에서 맞는 워크스페이스를 고르세요. |
| "이미 연결되어 있습니다" 오류 | 그 Notion 워크스페이스는 이미 연결돼 있습니다. `/multi-workspace:workspace-list`로 확인하세요. |
| 인증이 만료됐다는 오류로 호출이 실패함 | `/multi-workspace:workspace-check`로 확인한 뒤, 그 워크스페이스를 지우고 다시 추가하세요. |
| Claude가 엉뚱한 Notion 도구를 씀 | 이 플러그인을 쓰는 곳에서 claude.ai Notion 커넥터를 끄세요. |

## 로드맵

- [x] 워크스페이스 연결 (DCR, PKCE, localhost 콜백, OS 보관함, 워크스페이스 확인)
- [x] 공식 도구에 `workspace` 파라미터를 붙여 전달, 요금제에 따른 도구 차이 처리
- [x] 워크스페이스 관리를 MCP 도구와 플러그인 스킬로: 연결, 해제, 확인
- [x] `search_all_workspaces`: 모든 워크스페이스를 한 번에 검색하고 결과에 출처 표시
- [x] 토큰 갱신에 파일 잠금을 걸어 여러 프로세스가 같은 워크스페이스를 안전하게 쓰기
- [x] 페이지 ID로 하는 호출이 실패하면 그 페이지가 실제로 있는 워크스페이스로 다시 보내기
- [x] 워크스페이스를 지울 때 Notion 쪽 접근 권한도 해제
- [x] Claude Code 플러그인
- [x] 패키징: npm 패키지는 의존성 없이 묶은 서버 하나만 담고, `npm run pack:mcpb`로 Claude Desktop 확장을 만든다
- [x] npm에 배포하고, Claude Desktop에서 확장 시험하기
- [x] macOS, Windows, Linux 지원: OS마다 자체 보관함과 시스템 확인 창 사용
- [x] 연결 해제는 언제나 사용자 확인을 받기: Claude 확인 창 또는 시스템 확인 창
- [ ] Codex 같은 다른 MCP 클라이언트에서 시험하기

## 개발

```bash
npm install
npm run typecheck
npm test             # 단위 테스트
npm run build        # src/를 plugin/server.mjs 하나로 묶음
npm run check:bundle # 커밋한 뒤: 커밋된 묶음 파일이 src/와 다르면 실패
npm run dev          # 소스에서 바로 MCP 서버(stdio) 실행
npm run dev -- list  # 소스에서 바로 CLI 실행
npm run pack:mcpb    # Claude Desktop 확장
```

| 파일 | 역할 |
| --- | --- |
| `src/index.ts` | 진입점. 인자가 없으면 MCP 서버, 있으면 CLI |
| `src/server.ts` | MCP 서버, 도구 목록, 안내문 |
| `src/management.ts` | 워크스페이스 관리 도구 |
| `src/proxy.ts` | 워크스페이스별 도구 목록을 합치고 호출을 보낼 곳을 고름 |
| `src/upstream.ts` | 워크스페이스별 업스트림 세션, 도구 목록 캐시 |
| `src/connect.ts` | 워크스페이스 연결, 다시 붙기, 지우기 |
| `src/lock.ts` | 인증 저장을 감싸는, 서버 프로세스끼리 공유하는 잠금 |
| `src/oauth.ts` | OS 보관함을 쓰는 OAuth 클라이언트 |
| `src/callback-server.ts` | 인증 결과를 받는 임시 서버 |
| `src/keychain.ts` | OS별 토큰 보관: 키체인, Secret Service, DPAPI |
| `src/dialog.ts` | OS별 시스템 확인 대화상자 |
| `src/notion.ts` | 공식 Notion MCP 서버에 붙는 클라이언트 세션 |
| `src/config.ts` | 비밀이 아닌 설정 파일 |
| `plugin/server.mjs` | 플러그인이 실행하는, 하나로 묶은 서버 파일. `src/`를 고치면 `npm run build`로 다시 만들어 함께 커밋합니다. |
| `manifest.json`, `.mcpbignore` | Claude Desktop 확장 매니페스트와 거기서 뺄 파일 |
| `.claude-plugin/`, `skills/` | 플러그인 정보, 마켓플레이스 항목, 스킬 |

## 라이선스

[MIT](LICENSE)
