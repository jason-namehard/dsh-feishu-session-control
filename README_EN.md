<h1 align="center">DSH Feishu Session Control</h1>

<p align="center">🇨🇳 <a href="README.md">中文</a> · 📦 <a href="docs/PROJECT_IDENTITY.md">Project identity and provenance</a></p>

<p align="center">
  <strong>Connect each Feishu chat to a controllable DSH session</strong><br>
  Web sessions stay local by default · Feishu attaches on demand · half/full modes are switchable
</p>

> **Provenance**: this project is a **fork** of
> [`PlutoKeating/dsh-lark-bot`](https://github.com/PlutoKeating/dsh-lark-bot) (AGPL-3.0). The Feishu persistent
> connection, command routing, approval flow, and workspace scaffolding originate upstream; its copyright and
> AGPL-3.0 obligations continue to apply.
>
> Maintained by **见川**, this repository targets DSH `0.1.5-rc.3` (with a retained `0.1.2-rc.1` compatibility claim), cross-workspace
> aliases, recycle-bin and permanent deletion, an integrated Web session manager, half/full Feishu attachment,
> and a unified approval path that mirrors only native DSH approvals. See [`NOTICE.md`](NOTICE.md) and
> [`docs/PROJECT_IDENTITY.md`](docs/PROJECT_IDENTITY.md).

## Purpose

This package combines the Feishu/Lark bridge, remote DSH session control, and Web session management. The npm/DSH
package name remains `dsh-lark-bot` for compatibility; the project and repository are named
**DSH Feishu Session Control / dsh-feishu-session-control**.

- Uses Feishu's WebSocket connection; no public IP, domain, server, or tunnel is required.
- Runs in the DSH host process and primarily targets DSH `0.1.5-rc.3` (also retaining `0.1.2-rc.1` compatibility).
- Contains no Guardian: it never takes over, starts, or restarts DSH after DSH stops.
- Sessions created in Web are detached from Feishu unless a Feishu chat explicitly attaches to them.

## Session Semantics

| Action | Result |
| --- | --- |
| Create a session in Web | Remains detached; its messages and approvals stay in Web |
| Send the first ordinary message in a Feishu chat | Creates a dedicated DSH session and attaches in **half** mode |
| `/use 0909-1` | Switches this chat to that session without replaying history; mode resets to half |
| `/switch` | Opens a card to select half or full attachment |
| `/detach` | Removes only the Feishu attachment; the DSH session remains |
| Stop DSH | Feishu disconnects with it; the plugin does not take over or relaunch DSH |

**Half connection**: a Feishu-origin turn is fully visible in Web and its final answer returns to Feishu. A later
turn started independently from Web/TUI is not copied to Feishu.

**Full connection**: Web/TUI-origin messages and replies in the attached session are also copied to the current
Feishu chat.

## Quick Start

Prerequisites: Node.js 22 or newer, DeepSeek Harness, a configured model/API key, and a Feishu/Lark custom app.

```bash
git clone https://github.com/jason-namehard/dsh-feishu-session-control.git
cd dsh-feishu-session-control
corepack enable
pnpm install
pnpm build
node bin/dsh-lark-bot.mjs setup --profile dsh-lark --package file:/absolute/path/to/dsh-feishu-session-control
dsh --profile web
```

On Windows, the local package spec can look like
`file:E:/DeepSeekHarness/dsh-plugins/dsh-feishu-session-control`. `setup` installs the same integrated package into the
bridge profile and the `web` profile. Bind the app using the QR code printed at first start, or provide
`DSH_LARK_APP_ID`, `DSH_LARK_APP_SECRET`, and `DSH_LARK_TENANT`.

> This fork is not yet published under an independent npm package name. Do not run `npx dsh-lark-bot@latest`;
> that name resolves to the upstream project.

See [`docs/QUICK_START.md`](docs/QUICK_START.md) for details.

## Main Commands

| Command | Purpose |
| --- | --- |
| `/sessions` | List sessions across workspaces with `MMDD-N` aliases, titles, state, and the current-chat marker |
| `/new [name]` | Create a session; without a name, open a form that also accepts an empty value |
| `/use <alias>` | Attach an existing session without history replay |
| `/switch` | Select half or full attachment |
| `/detach` | Detach this Feishu chat from its session |
| `/rename <alias> [name]` | Rename the DSH session and synchronize the Web UI title |
| `/delete <alias>` | Move to the recycle bin after confirmation; aliases are never renumbered |
| `/purge <alias>` | Permanently delete after confirmation |
| `/mention on\|off\|default [chatId]` | Configure whether a group requires an `@` mention |
| `/status` | Show the current scope, session, attachment, and task state |
| `/upgrade` | Run a confirmed update inside the current DSH process |

Use `/help` for the complete catalog. See [`docs/SESSION_MANAGEMENT.md`](docs/SESSION_MANAGEMENT.md) for lifecycle
details.

## Approval Model

The plugin adds **no per-tool approval gate or custom permission policy**. It mirrors an approval to Feishu only
after DSH itself has requested one:

- Web and Feishu represent the same approval request.
- Approval from either side is sufficient (OR semantics).
- A detached Web session is not forced into Feishu.
- DSH still decides when a dangerous operation or a genuine plan choice needs confirmation.

Tools such as `pwsh` and `write` therefore do not gain an extra approval layer merely because the task came from
Feishu.

## Group Chats

A normal group chat maps to one shared session. Only new message events are processed; the bridge does not inject
the complete group history on every turn. To reply without `@`, grant the application-identity permission
`im:message.group_msg` in the Feishu developer console and run `/mention off`. Use `/mention on` for groups that
should remain mention-only.

## Web Session Manager

The integrated panel supports archive, restore, recycle bin, permanent deletion, details, favorites, and moving
sessions across workspaces. Web exposes permanent deletion only inside the recycle bin. Feishu keeps
`/purge <alias>` and always requires a second confirmation.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

On Windows without Developer Mode, tests that create directory symlinks may fail with `EPERM`; POSIX `0600` mode
assertions are also not meaningful on Windows. The core session, approval, and in-process upgrade suites do not
depend on those platform features.

## License

- Main license: [`LICENSE`](LICENSE) (GNU AGPL-3.0)
- Upstream and third-party notices: [`NOTICE.md`](NOTICE.md)
- Integrated `dsh-sessions-manager` MIT license:
  [`THIRD_PARTY_LICENSES/dsh-sessions-manager-MIT.txt`](THIRD_PARTY_LICENSES/dsh-sessions-manager-MIT.txt)
