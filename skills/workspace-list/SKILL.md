---
name: workspace-list
description: 연결된 Notion 워크스페이스 목록과 상태를 보여준다. 사용자가 어떤 노션 워크스페이스가 연결돼 있는지 물을 때 쓴다.
---

# 워크스페이스 목록

multi-workspace MCP 서버의 `workspace_list` 도구를 호출하고, 결과를 사용자의 언어로 표 하나로 정리한다.

| 열 | 값 |
| --- | --- |
| 워크스페이스 | `name` |
| 설명 | `description` (없으면 비움) |
| 상태 | `status`: connected는 정상, needs_reauth는 다시 연결 필요, error는 오류 |
| 마지막 확인 | `lastSuccessAt`을 사용자에게 익숙한 날짜·시각으로 |

- 연결된 워크스페이스가 없으면 `/multi-workspace:workspace-add`로 연결할 수 있다고 알려준다.
- `needs_reauth`나 `error`인 워크스페이스가 있으면 `/multi-workspace:workspace-check <이름>`으로 확인하거나, 연결을 해제한 뒤 다시 연결하라고 안내한다.
- 워크스페이스 ID는 사용자가 묻지 않으면 보여주지 않는다.
