---
name: workspace-check
description: Notion 워크스페이스 연결이 살아 있는지, 처음 연결한 그 워크스페이스가 맞는지 확인한다. 인자가 없으면 연결된 워크스페이스를 모두 확인한다.
argument-hint: "[워크스페이스 이름]"
---

# 워크스페이스 연결 확인

인자: `$ARGUMENTS`

1. 인자로 이름을 받았으면 그 워크스페이스만, 없으면 multi-workspace MCP 서버의 `workspace_list` 도구로 목록을 받아 모든 워크스페이스를 확인한다.
2. 워크스페이스마다 `workspace_check` 도구를 `workspace`(목록의 `name` 그대로)로 호출한다. 여러 개면 동시에 호출해도 된다.
3. 결과를 표 하나로 정리한다: 워크스페이스, 결과(정상 / 다시 연결 필요 / 오류), 도구 수 또는 문제 내용.
4. 문제가 있는 워크스페이스는 다음처럼 안내한다.
   - `needs_reauth`: 저장된 인증이 만료됐다. `/multi-workspace:workspace-remove <이름>` 후 `/multi-workspace:workspace-add`로 다시 연결한다.
   - 다른 워크스페이스에 붙어 있다는 오류: 위와 같이 다시 연결하면서 Notion 화면에서 맞는 워크스페이스를 고른다.
   - 그 밖의 오류: 네트워크 문제일 수 있으니 잠시 뒤 다시 확인하고, 계속되면 오류 내용을 그대로 보여준다.
