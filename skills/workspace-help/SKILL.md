---
name: workspace-help
description: Multi-Workspace for Notion의 스킬, 도구, 사용 예를 한 화면에 보여준다. 사용자가 이 플러그인 사용법이나 명령 목록을 물을 때 쓴다.
---

# 도움말

아래 내용을 사용자의 언어로 그대로 보여준다. 도구를 호출하지 않는다.

**Multi-Workspace for Notion**: 여러 Notion 워크스페이스를 동시에 연결하고, 공식 Notion 도구를 호출마다 `workspace`로 골라 쓴다.

| 스킬 | 하는 일 |
| --- | --- |
| `/multi-workspace:workspace-list` | 연결된 워크스페이스와 상태 |
| `/multi-workspace:workspace-add [설명]` | 브라우저 로그인으로 워크스페이스 연결. Notion에서의 이름으로 불린다 |
| `/multi-workspace:workspace-remove <이름>` | 확인 후 연결 해제(이 컴퓨터의 토큰 삭제, Notion 쪽 토큰 해제) |
| `/multi-workspace:workspace-check [이름]` | 연결이 살아 있고 맞는 워크스페이스인지 확인 |
| `/multi-workspace:workspace-help` | 이 도움말 |

사용 예: "모든 노션에서 '로드맵' 찾아 줘"(`search_all_workspaces`로 한 번에 검색), "회사 노션과 개인 노션에서 각각 '로드맵'을 검색해 줘", "개인 노션에 오늘 회의 메모 페이지 만들어 줘"

알아 둘 점:
- 워크스페이스는 Notion에서의 이름으로 부른다. 새로 연결한 워크스페이스는 이 대화에서 바로 쓸 수 있다.
- claude.ai Notion 커넥터도 켜져 있으면 Notion 도구가 두 벌 보이므로 꺼 두는 게 좋다.
- 세션을 시작할 때 연결된 워크스페이스가 한 줄로 표시된다.
