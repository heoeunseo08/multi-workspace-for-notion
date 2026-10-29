---
name: workspace-add
description: 새 Notion 워크스페이스를 연결한다. 브라우저에서 Notion 로그인과 워크스페이스 선택이 필요하고, 연결된 워크스페이스는 Notion에서의 이름으로 불린다.
argument-hint: "[설명]"
disable-model-invocation: true
---

# 워크스페이스 연결

인자: `$ARGUMENTS` (전부 설명이다)

1. 설명이 없으면 그 워크스페이스에 무엇이 있는지 한 줄로 물어본다. 사용자가 건너뛰면 빈 설명으로 진행한다. 설명은 나중에 Claude가 워크스페이스를 고를 때 쓰인다.
2. multi-workspace MCP 서버의 `workspace_connect` 도구를 `description`으로 호출한다. 결과는 바로 돌아오고 `authorizationUrl`이 들어 있다.
3. 사용자에게 알린다: 브라우저에 Notion 로그인 화면이 열렸을 것이고, 안 열렸으면 `authorizationUrl`을 직접 열면 된다(주소를 클릭할 수 있게 보여준다). 연결할 워크스페이스를 골라 승인하고, 끝나면 알려 달라고 한다. 최대 10분 기다린다.
4. 사용자가 승인했다고 하면 `workspace_connect`를 다시 호출해 결과를 받는다. 아직 `waiting_for_approval`이면 승인이 끝났는지 다시 확인한다.
5. 결과를 알려준다.
   - 성공(`status: connected`): 연결된 워크스페이스 이름(`connected.name`)을 보여주고, 의도한 워크스페이스가 맞는지 확인을 부탁한다. 다르다면 `/multi-workspace:workspace-remove` 후 다시 연결하면 된다고 알린다. 이 대화에서 바로 쓸 수 있다.
   - 이미 연결된 워크스페이스라는 오류: 사용자가 Notion 화면에서 다른 워크스페이스를 골랐어야 한다. 오류 내용을 그대로 전한다.
   - 시간 초과: 로그인 화면이 열렸는지 묻고, 다시 시도하자고 제안한다.
