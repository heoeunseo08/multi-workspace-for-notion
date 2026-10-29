import assert from "node:assert/strict";
import { test } from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { callProxiedTool, callSearchAll, mergeCatalogs, searchAllTool, SERVER_MARK, type UpstreamCall } from "./proxy.js";

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: `${name} 설명`,
  inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  ...extra,
});

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

test("shared tools get a required plain-string workspace param naming every workspace", () => {
  const { tools } = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-search")] },
    { alias: "sueori", tools: [tool("notion-search")] },
  ]);
  assert.equal(tools.length, 1);
  const schema = tools[0]!.inputSchema;
  assert.deepEqual(schema.required, ["workspace", "query"]);
  const param = schema.properties!.workspace as { type: string; enum?: string[]; description: string };
  assert.equal(param.type, "string");
  assert.equal(param.enum, undefined, "an enum would go stale after a connect or rename");
  assert.match(param.description, /personal, sueori/);
  assert.deepEqual(Object.keys(schema.properties!), ["workspace", "query"]);
  assert.equal(tools[0]!.description, "notion-search 설명");
});

test("tools in only some workspaces list just those workspaces and say so in the description", () => {
  const { tools, availability } = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-search")] },
    { alias: "sueori", tools: [tool("notion-search"), tool("notion-query-meeting-notes")] },
  ]);
  const meeting = tools.find((t) => t.name === "notion-query-meeting-notes")!;
  assert.match((meeting.inputSchema.properties!.workspace as { description: string }).description, /워크스페이스: sueori\./);
  assert.match(meeting.description!, /^\[이 도구는 sueori 워크스페이스에서만 쓸 수 있다\]/);
  assert.deepEqual(availability.get("notion-query-meeting-notes"), ["sueori"]);
});

test("keeps the original title, annotations and outputSchema", () => {
  const original = tool("notion-fetch", {
    title: "Fetch",
    annotations: { readOnlyHint: true },
    outputSchema: { type: "object", properties: { x: { type: "string" } } },
  });
  const [merged] = mergeCatalogs([{ alias: "personal", tools: [original] }]).tools;
  assert.equal(merged!.title, "Fetch");
  assert.deepEqual(merged!.annotations, { readOnlyHint: true });
  assert.deepEqual(merged!.outputSchema, original.outputSchema);
});

test("warns on differing input schemas and uses the first definition", () => {
  const warnings: string[] = [];
  const other = tool("notion-search", { inputSchema: { type: "object", properties: { q: { type: "string" } } } });
  const { tools } = mergeCatalogs(
    [
      { alias: "personal", tools: [tool("notion-search")] },
      { alias: "sueori", tools: [other] },
    ],
    (m) => warnings.push(m),
  );
  assert.ok("query" in tools[0]!.inputSchema.properties!);
  assert.equal(warnings.length, 1);
});

test("hides tools that already have a workspace param", () => {
  const warnings: string[] = [];
  const clash = tool("x", { inputSchema: { type: "object", properties: { workspace: { type: "string" } } } });
  const { tools, availability } = mergeCatalogs([{ alias: "personal", tools: [clash] }], (m) => warnings.push(m));
  assert.equal(tools.length, 0);
  assert.equal(availability.has("x"), false);
  assert.equal(warnings.length, 1);
});

test("a call strips workspace and forwards the rest to that workspace", async () => {
  const catalog = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-search")] },
    { alias: "sueori", tools: [tool("notion-search")] },
  ]);
  const calls: unknown[] = [];
  const call: UpstreamCall = async (alias, name, args) => {
    calls.push({ alias, name, args });
    return { content: [{ type: "text", text: "결과" }], structuredContent: { n: 1 } };
  };
  const result = await callProxiedTool(catalog, "notion-search", { workspace: "sueori", query: "회의" }, call);
  assert.deepEqual(calls, [{ alias: "sueori", name: "notion-search", args: { query: "회의" } }]);
  assert.deepEqual(result, { content: [{ type: "text", text: "결과" }], structuredContent: { n: 1 } });
});

test("never calls upstream for a missing, unknown or unsupported workspace", async () => {
  const catalog = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-search")] },
    { alias: "sueori", tools: [tool("notion-search"), tool("notion-query-meeting-notes")] },
  ]);
  let called = false;
  const call: UpstreamCall = async () => ((called = true), ok(""));

  const missing = await callProxiedTool(catalog, "notion-search", { query: "a" }, call);
  assert.equal(missing.isError, true);
  assert.match(text(missing), /workspace 파라미터가 필요합니다/);

  const unknownWorkspace = await callProxiedTool(catalog, "notion-search", { workspace: "nope", query: "a" }, call);
  assert.match(text(unknownWorkspace), /연결되지 않은 워크스페이스입니다: nope/);

  const planGap = await callProxiedTool(catalog, "notion-query-meeting-notes", { workspace: "personal" }, call);
  assert.match(text(planGap), /personal 워크스페이스에서 쓸 수 없습니다.*쓸 수 있는 워크스페이스: sueori/);

  const unknownTool = await callProxiedTool(catalog, "nope", { workspace: "personal" }, call);
  assert.match(text(unknownTool), /알 수 없는 도구입니다/);

  assert.equal(called, false);
});

test("an upstream exception becomes an error result naming the workspace", async () => {
  const catalog = mergeCatalogs([{ alias: "personal", tools: [tool("notion-search")] }]);
  const result = await callProxiedTool(catalog, "notion-search", { workspace: "personal", query: "a" }, async () => {
    throw new Error("network down");
  });
  assert.equal(result.isError, true);
  assert.equal(text(result), "personal 워크스페이스 호출 실패: network down");
});

test("search_all_workspaces exists only with two notion-search workspaces and drops workspace", () => {
  const one = mergeCatalogs([{ alias: "personal", tools: [tool("notion-search")] }]);
  assert.equal(searchAllTool(one), undefined);

  const two = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-search")] },
    { alias: "sueori", tools: [tool("notion-search")] },
  ]);
  const searchAll = searchAllTool(two)!;
  assert.deepEqual(Object.keys(searchAll.inputSchema.properties!), ["query"]);
  assert.deepEqual(searchAll.inputSchema.required, ["query"]);
  assert.match(searchAll.description!, /personal, sueori/);
});

test("search_all_workspaces queries every workspace and returns the rest when some fail", async () => {
  const catalog = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-search")] },
    { alias: "sueori", tools: [tool("notion-search")] },
    { alias: "free", tools: [] },
  ]);
  const calls: unknown[] = [];
  const call: UpstreamCall = async (alias, name, args) => {
    calls.push({ alias, name, args });
    if (alias === "sueori") throw new Error("network down");
    return ok(`${alias} 결과`);
  };
  const result = await callSearchAll(catalog, { workspace: "x", query: "회의" }, call);
  assert.deepEqual(calls, [
    { alias: "personal", name: "notion-search", args: { query: "회의" } },
    { alias: "sueori", name: "notion-search", args: { query: "회의" } },
  ]);
  assert.equal(result.isError, false);
  assert.deepEqual(
    result.content.map((c) => (c as { text: string }).text),
    [`\n${SERVER_MARK} ## workspace: personal`, "personal 결과", `\n${SERVER_MARK} ## workspace: sueori (실패)`, "호출 실패: network down"],
  );

  const allFail = await callSearchAll(catalog, { query: "a" }, async () => { throw new Error("down"); });
  assert.equal(allFail.isError, true);
});

const notFound: CallToolResult = {
  isError: true,
  content: [{ type: "text", text: '{"code":"object_not_found","status":404}' }],
};

test("a read tool hitting object_not_found tries other workspaces and says where it found it", async () => {
  const catalog = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-fetch", { annotations: { readOnlyHint: true } })] },
    { alias: "sueori", tools: [tool("notion-fetch", { annotations: { readOnlyHint: true } })] },
    { alias: "team", tools: [tool("notion-fetch", { annotations: { readOnlyHint: true } })] },
  ]);
  const calls: string[] = [];
  const call: UpstreamCall = async (alias) => {
    calls.push(alias);
    return alias === "team" ? ok("페이지") : notFound;
  };
  const result = await callProxiedTool(catalog, "notion-fetch", { workspace: "personal", query: "id" }, call);
  assert.deepEqual(calls, ["personal", "sueori", "team"]);
  assert.equal(result.isError, undefined);
  assert.ok(text(result).startsWith(SERVER_MARK));
  assert.match(text(result), /personal 워크스페이스에는 없어서 team 워크스페이스에서 찾은 결과다/);
  assert.equal((result.content[1] as { text: string }).text, "페이지");

  const nowhere = await callProxiedTool(catalog, "notion-fetch", { workspace: "personal", query: "id" }, async () => notFound);
  assert.deepEqual(nowhere, notFound);
});

test("a read-only-hinted tool that isn't on the local allowlist is not fanned out", async () => {
  // readOnlyHint comes from the upstream and must not opt a tool into cross-workspace retry.
  const catalog = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-get-comments", { annotations: { readOnlyHint: true } })] },
    { alias: "sueori", tools: [tool("notion-get-comments", { annotations: { readOnlyHint: true } })] },
  ]);
  const calls: string[] = [];
  const result = await callProxiedTool(catalog, "notion-get-comments", { workspace: "personal", query: "id" }, async (alias) => {
    calls.push(alias);
    return notFound;
  });
  assert.deepEqual(calls, ["personal"]);
  assert.equal(result.isError, true);
});

test("a write tool hitting object_not_found only adds a hint, never retries elsewhere", async () => {
  const catalog = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-update-page")] },
    { alias: "sueori", tools: [tool("notion-update-page")] },
  ]);
  const calls: string[] = [];
  const result = await callProxiedTool(catalog, "notion-update-page", { workspace: "personal", query: "id" }, async (alias) => {
    calls.push(alias);
    return notFound;
  });
  assert.deepEqual(calls, ["personal"]);
  assert.equal(result.isError, true);
  assert.match(text(result), /다른 워크스페이스\(sueori\)의 ID일 수 있다/);
});

test("returns other errors unchanged", async () => {
  const catalog = mergeCatalogs([
    { alias: "personal", tools: [tool("notion-fetch", { annotations: { readOnlyHint: true } })] },
    { alias: "sueori", tools: [tool("notion-fetch", { annotations: { readOnlyHint: true } })] },
  ]);
  const other: CallToolResult = { isError: true, content: [{ type: "text", text: "validation_error" }] };
  const calls: string[] = [];
  const result = await callProxiedTool(catalog, "notion-fetch", { workspace: "personal", query: "id" }, async (alias) => {
    calls.push(alias);
    return other;
  });
  assert.deepEqual(calls, ["personal"]);
  assert.deepEqual(result, other);
});

function text(result: CallToolResult): string {
  return (result.content[0] as { text: string }).text;
}

test("server labels carry a random per-process mark that page text cannot guess", () => {
  assert.match(SERVER_MARK, /^\[mwn-[0-9a-f]{8}\]$/);
});
