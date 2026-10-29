<h1 align="center">Multi-Workspace for Notion</h1>

<p align="center"><em>One Claude Code, every Notion workspace. The official tools, untouched.</em></p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.4.1-111111?style=flat-square" alt="Version 0.4.1">
  <img src="https://img.shields.io/badge/Claude%20Code-plugin-111111?style=flat-square" alt="Claude Code plugin">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-111111?style=flat-square" alt="macOS, Windows, Linux">
  <img src="https://img.shields.io/badge/license-MIT-111111?style=flat-square" alt="MIT license">
</p>

<p align="center"><sub><a href="README.md">English</a> &middot; <a href="README.ko.md">한국어</a></sub></p>

---

Use several Notion workspaces at the same time from Claude Code, with every tool the official Notion MCP server offers.

> **Status: early development (v0.4.1).** Connecting workspaces and proxying the official tools work and have been tested with real workspaces on macOS and Windows, in Claude Code (terminal and VS Code extension) and Claude Desktop. Linux is tested in CI against a real GNOME Keyring and `zenity`. Several planned pieces are still missing; see [Roadmap](#roadmap) and [Known limitations](#known-limitations).
>
> This is an unofficial project. It is not affiliated with or endorsed by Notion Labs, Inc.

## Why

Notion's official MCP connector links one workspace per connection. To switch, you disconnect and sign in again, which affects every other conversation too. claude.ai also refuses to add a second connector with the same URL (`https://mcp.notion.com/mcp`).

Claude Code does let you register that URL twice under different names, but:

- every connection copies the full tool set (about 65 tools), so two workspaces mean about 130 tools and three mean about 195;
- you name each connection yourself, and nothing checks which workspace you actually picked on Notion's sign-in page, so `notion-work` can quietly end up pointing at your personal workspace;
- nothing works across workspaces, such as searching all of them at once.

Other open-source projects call the Notion REST API directly and expose a handful of hand-written tools. This project instead sits in front of the official hosted server, so you get the official tools as they are, and pick up Notion's changes to them automatically.

## How it works

```
Claude Code
    │  stdio (Claude starts the server as a child process)
    ▼
Multi-Workspace for Notion  (local Node process)
    │  routes each call by its `workspace` argument
    ├──▶ mcp.notion.com   [My Notion]
    ├──▶ mcp.notion.com   [Acme]
    └──▶ mcp.notion.com   [...]
```

- **One OAuth client per workspace.** When you connect a workspace, the server registers itself with Notion's MCP server (Dynamic Client Registration), signs in with PKCE, and receives the callback on a temporary `localhost` port.
- **Checks the workspace you picked.** Right after sign-in it calls `notion-get-self` and records the real workspace name and ID. Picking a workspace that is already connected is refused.
- **Exposes the official tools once.** Each tool gets one extra, required `workspace` parameter. Its allowed values are the workspaces that have that tool, so tools missing from some plans can't be sent to the wrong workspace. Everything else about the call and its result passes through unchanged.
- **Uses Notion's own names.** A workspace is called by its name in Notion, read right after sign-in, so there is nothing to name and nothing that can point at the wrong workspace. If two connected workspaces share a name, the second gets the start of its ID, such as `My Notion (1a2b3c4d)`.
- **Tells Claude what is connected.** The server's instructions list each workspace's name and description, ask Claude to confirm the workspace before writing when it is unclear, and then include Notion's own instructions.

What Claude sends looks like this:

```json
{ "name": "notion-search", "arguments": { "workspace": "Acme", "query": "roadmap" } }
```

## Requirements

- macOS, Windows or Linux. Tokens are kept in the OS credential store, never in plain text:
  - macOS: the Keychain, through the built-in `security` command
  - Windows: files encrypted with DPAPI (only your Windows account can decrypt them), through the built-in PowerShell
  - Linux: the Secret Service (GNOME Keyring, KWallet) through `secret-tool`; install `libsecret-tools` (Debian/Ubuntu) or `libsecret` (Fedora/Arch)
- Node.js 20 or newer
- Claude Code

## Install as a Claude Code plugin (recommended)

The repository is a Claude Code plugin marketplace. The plugin ships the MCP server as one bundled file, so there is nothing to build.

```bash
claude plugin marketplace add heoeunseo08/multi-workspace-for-notion
claude plugin install multi-workspace@multi-workspace-for-notion
```

Start a new Claude Code session, then connect each workspace:

```
/multi-workspace:workspace-add My personal notes
/multi-workspace:workspace-add Company wiki
```

Your browser opens Notion's sign-in page: choose the workspace you want and approve. It is then called by its name in Notion. Claude also shows the sign-in link, in case the browser didn't open. Tell Claude when you've approved; it then shows which workspace was actually connected. If it is not the one you meant, remove it and add it again. The new workspace works in the same conversation.

- The description is optional. Claude sees it, so a few words about what lives in the workspace help it choose.
- Sign-in waits up to 10 minutes.
- Upgrading from 0.1.x, where you named each workspace yourself: on first start your connections are renamed after their Notion workspaces, without signing in again.

If the claude.ai Notion connector is also enabled, Claude sees two sets of Notion tools. Turn that connector off where you use this plugin so Claude doesn't mix them up.

Then ask in plain language, for example "Search for 'roadmap' in both my work and personal Notion". Claude picks the `workspace` value from the workspace names and descriptions.

## Skills

| Skill | What it does |
| --- | --- |
| `/multi-workspace:workspace-list` | Shows connected workspaces with their real names, descriptions and status. |
| `/multi-workspace:workspace-add [description]` | Connects a workspace through the browser and shows which workspace you actually picked. |
| `/multi-workspace:workspace-remove <name>` | Shows a confirmation dialog, then deletes the workspace's tokens and settings from this computer and revokes the tokens on Notion's side. |
| `/multi-workspace:workspace-check [name]` | Signs in again with the saved tokens and checks each workspace still works and is the one you connected. |
| `/multi-workspace:workspace-help` | Shows the skills, tools and example requests on one screen. |

`workspace-add` and `workspace-remove` run only when you type them; Claude doesn't start them on its own.

Each new session also starts with a one-line status, such as `Notion: My Notion, Acme`, and points you to `workspace-check` when a workspace needs attention.

## Claude Desktop extension (`.mcpb`)

Download `multi-workspace-for-notion.mcpb` from the [latest release](https://github.com/heoeunseo08/multi-workspace-for-notion/releases/latest), or build it yourself:

```bash
npm install
npm run pack:mcpb    # writes multi-workspace-for-notion.mcpb
```

Open the file with Claude Desktop to install it, then ask Claude to connect a workspace (`workspace_connect`). Desktop has no plugin skills, so use the tools directly.

## Install from source

Use this to work on the code, or to run the server without the plugin.

```bash
git clone https://github.com/heoeunseo08/multi-workspace-for-notion.git
cd multi-workspace-for-notion
npm install
npm run build
node plugin/server.mjs add "My personal notes"
claude mcp add --scope user multi-workspace -- node /absolute/path/to/multi-workspace-for-notion/plugin/server.mjs
```

Then check that `multi-workspace` shows as connected in `claude mcp list`.

## CLI reference

| Command | What it does |
| --- | --- |
| `node plugin/server.mjs` | Runs the MCP server over stdio. Claude runs this; you don't need to. |
| `node plugin/server.mjs list` | Lists connected workspaces: name, status, description. |
| `node plugin/server.mjs add [description...]` | Connects a workspace through the browser. |
| `node plugin/server.mjs tools <name>` | Signs in with the saved tokens, confirms the workspace, and lists its tools. Useful to check a connection still works. |
| `node plugin/server.mjs remove <name>` | Asks in a system dialog first (where none can be shown, as over SSH, you type the workspace name in the terminal; piped input never counts), then deletes the workspace's tokens and settings from this computer and revokes the tokens on Notion's side. There is no option to skip the question, so a shell tool can't use this to bypass the chat confirmation. |

CLI messages are currently in Korean.

## Tools exposed to Claude

| Tool | Description |
| --- | --- |
| Every official Notion tool | Same name, description and options, plus a required `workspace` parameter. If a read-only tool can't find an ID in that workspace, it is retried in the others and the result says which workspace has it. Write tools are never sent to a workspace you didn't pick. |
| `search_all_workspaces` | Runs `notion-search` in every workspace at once and groups the results by workspace. Shown when two or more workspaces are connected. |
| `workspace_list` | Shows the connected workspaces: name, ID, description, status, and when the connection was last confirmed. |
| `workspace_connect` | Starts connecting a workspace and returns the sign-in link at once; call it again for the result (sign-in waits up to 10 minutes). |
| `workspace_disconnect` | Deletes a workspace's tokens and settings from this computer and revokes the tokens on Notion's side. Before doing so you confirm it yourself: in Claude's own dialog (MCP elicitation) where the client has one, as in Claude Code in a terminal, otherwise in a system dialog drawn by the OS (Claude Desktop, the VS Code extension): `osascript` on macOS, a PowerShell message box on Windows, `zenity` or `kdialog` on Linux. Claude cannot answer either; without a yes, nothing is deleted. |
| `workspace_check` | Signs in again with the saved tokens, confirms the workspace and updates its status. |

## Where data is stored

| What | Where |
| --- | --- |
| OAuth tokens and client registration | OS credential store, service `multi-workspace-for-notion`, account `workspace:<workspace ID>` (Windows: `credentials/` in the config folder, DPAPI-encrypted) |
| Workspace names, IDs and descriptions | `~/.config/multi-workspace-for-notion/config.json` |
| Cached tool lists and instructions | `~/.config/multi-workspace-for-notion/cache/` |
| Lock files for saving tokens | `~/.config/multi-workspace-for-notion/locks/` |

Set `MWN_CONFIG_DIR` to use a different directory; point it at a private, owner-only path (the default is created with `0700`). Files are written with owner-only permissions and never contain tokens.

## Security

- The server talks to Claude over stdio and opens no network port in normal use.
- While you sign in, a callback server listens on `127.0.0.1` and `::1` only. It accepts one response, checks the OAuth `state`, then closes.
- Tokens live only in the OS credential store. They are passed to its tool on standard input, so they never appear in the process list.
- Disconnecting always needs your own yes, in a dialog Claude can't answer: `workspace_disconnect` and the CLI `remove` alike. If the request is cancelled or Claude closes while the dialog is open, the dialog closes too and nothing is deleted.
- `remove` deletes the tokens from this computer first, then revokes them on Notion's side (RFC 7009). If revoking fails, for example offline, the result says so; remove the connection in Notion's settings under Connections.

## Known limitations

- **claude.ai web and mobile are not supported.** Their custom connectors accept only remote URLs.
- **Linux has not been tried on a real desktop yet**, only in CI and a container with GNOME Keyring and `zenity`. It needs a running Secret Service and `secret-tool`, and confirming a disconnect from Claude Desktop or the VS Code extension needs `zenity` or `kdialog`.
- **Other open sessions see workspace changes after a restart.** A connect or disconnect takes effect at once in the session that made it; other running sessions keep their old list until they restart.
- **MCP resources and prompts are not proxied.** Notion's `notion://docs/...` documents can still be read with `notion-fetch`; the server tells Claude to do so.
- **Startup fetches each workspace's tool list** (about a second for two workspaces). If a workspace can't be reached within 15 seconds, the last cached list is used.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Adding a workspace times out | Make sure the sign-in page actually opened. With the CLI, you can open the printed URL yourself and approve within 10 minutes. |
| The wrong workspace was connected | Remove it, then add it again and choose the right workspace on Notion's page. |
| "already connected" | That Notion workspace is already connected. Check with `/multi-workspace:workspace-list`. |
| Calls fail with an expired-sign-in error | Run `/multi-workspace:workspace-check`, then remove and add the workspace again. |
| Claude uses the wrong Notion tools | Turn off the claude.ai Notion connector where you use this plugin. |

## Roadmap

- [x] Connect workspaces (DCR, PKCE, localhost callback, OS credential store, workspace check)
- [x] Proxy the official tools with a `workspace` parameter and per-plan availability
- [x] Workspace management as MCP tools and plugin skills: connect, disconnect, check
- [x] `search_all_workspaces`: search every workspace at once, results labelled by workspace
- [x] File lock around token refresh so several processes can share a workspace safely
- [x] Retry calls that use a page ID in the workspace that actually owns the page
- [x] Revoke access on Notion's side when removing a workspace
- [x] Claude Code plugin
- [x] Packaging: the npm package ships only the bundled server, with no dependencies; `npm run pack:mcpb` builds a Claude Desktop extension
- [x] Publish to npm, and test the extension in Claude Desktop
- [x] macOS, Windows and Linux, each with its own credential store and system dialog
- [x] Confirm every disconnect with the user, in Claude's dialog or a system dialog
- [ ] Test other MCP clients, such as Codex

## Development

```bash
npm install
npm run typecheck
npm test             # unit tests
npm run build        # bundles src/ into plugin/server.mjs
npm run check:bundle # after committing: fails if the committed bundle doesn't match src/
npm run dev          # MCP server over stdio, from source
npm run dev -- list  # CLI, from source
npm run pack:mcpb    # Claude Desktop extension
```

| File | Role |
| --- | --- |
| `src/index.ts` | Entry point: MCP server without arguments, CLI otherwise |
| `src/server.ts` | MCP server, tool list, instructions |
| `src/management.ts` | Workspace management tools |
| `src/proxy.ts` | Merges workspaces' tool lists and routes calls |
| `src/upstream.ts` | Upstream session per workspace, tool list cache |
| `src/connect.ts` | Connect, reopen and remove a workspace |
| `src/lock.ts` | Lock shared by server processes, around credential saves |
| `src/oauth.ts` | OAuth client provider backed by the credential store |
| `src/callback-server.ts` | Temporary OAuth callback server |
| `src/keychain.ts` | Credential store per OS: Keychain, Secret Service, DPAPI |
| `src/dialog.ts` | System confirmation dialog per OS |
| `src/notion.ts` | Client session to the official Notion MCP server |
| `src/config.ts` | Non-secret settings file |
| `plugin/server.mjs` | Bundled server the plugin runs. Rebuild with `npm run build` and commit it whenever `src/` changes. |
| `manifest.json`, `.mcpbignore` | Claude Desktop extension manifest and the files it leaves out |
| `.claude-plugin/`, `skills/` | Plugin manifest, marketplace entry and skills |

## License

[MIT](LICENSE)
