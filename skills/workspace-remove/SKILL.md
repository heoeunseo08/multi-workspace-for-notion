---
name: workspace-remove
description: Notion 워크스페이스 연결을 해제한다. 이 컴퓨터에 저장된 토큰과 설정을 지우고 Notion 쪽 토큰도 해제한다.
argument-hint: <워크스페이스 이름>
disable-model-invocation: true
---

# 워크스페이스 연결 해제

인자: `$ARGUMENTS`

1. multi-workspace MCP 서버의 `workspace_list` 도구로 연결된 워크스페이스를 확인한다.
2. 인자로 받은 이름이 없거나 목록의 `name`과 맞지 않으면, 목록을 보여주고 어느 것을 해제할지 묻는다. 비슷한 이름이 하나뿐이면 그것이 맞는지 확인한다.
3. `workspace_disconnect` 도구를 `workspace`(목록의 `name` 그대로)로 호출한다. 서버가 사용자에게 확인 창을 띄우니(Claude 안의 확인 창, 또는 macOS 시스템 대화상자), 되돌릴 수 없고 다시 쓰려면 브라우저로 다시 연결해야 한다는 것을 확인 창에서 보고 승인하면 된다고 미리 알린다.
4. 승인되지 않았다는 오류가 오면 아무것도 지워지지 않은 것이다. 확인 창을 띄울 수 없었다는 오류라면, 사용자가 직접 터미널에서 `npx multi-workspace-for-notion remove "<이름>"`을 실행하면 된다고 알린다. 이 명령도 확인 창이나 이름 입력을 거친다. 이 명령을 대신 실행하지 않는다.
5. 결과를 알린다. `revokedOnNotion`이 false면 Notion 쪽 해제는 실패한 것이므로, Notion 설정의 연결(Connections) 메뉴에서 직접 해제하라고 안내한다.
