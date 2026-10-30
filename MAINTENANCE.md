# DSH Plugin Maintenance

This repository is the canonical source for the integrated DSH Feishu/Lark plugin. It is intentionally stored under the DSH installation area so that runtime maintenance does not depend on Mirasim or Codex.

## Canonical layout

- Source repository: `E:\DeepSeekHarness\dsh-plugins\dsh-feishu-session-control`
- Web profile: `E:\DeepSeekHarness\dsh-home\profiles\web`
- Feishu bridge profile: `E:\DeepSeekHarness\dsh-home\profiles\dsh-lark`
- DSH home and runtime logs: `E:\DeepSeekHarness\dsh-home`
- Session archive: `E:\DeepSeekHarness\dsh-home\sessions-archive`
- Session recycle bin: `E:\DeepSeekHarness\dsh-home\sessions-trash`
- DSH task workspace: `E:\DSHspace`

The source repository is the only place where plugin code should be edited. Do not edit the installed copy under `profiles\*\node_modules\dsh-lark-bot`.

## Runtime independence

The running DSH service uses the profile installations and the tray launcher at `E:\DeepSeekHarness\启动DSH.bat`. Mirasim and Codex are not runtime dependencies. To rebuild this plugin later, an Agent only needs the DSH installation, Node.js, Git, and pnpm/Corepack.

The repository keeps `dist` because the local DSH package loads the built artifacts. `node_modules` is intentionally not part of the maintained layout; recreate it with `corepack pnpm install` when source maintenance is needed.

## Safe source update

Stop DSH from the tray before replacing installed files or changing profile dependencies.

```powershell
Set-Location 'E:\DeepSeekHarness\dsh-plugins\dsh-feishu-session-control'
corepack enable
corepack pnpm install
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
node tools/sync-to-profile.mjs
corepack pnpm install --dir 'E:\DeepSeekHarness\dsh-home\profiles\dsh-lark'
corepack pnpm install --dir 'E:\DeepSeekHarness\dsh-home\profiles\web'
```

Start DSH again with `E:\DeepSeekHarness\启动DSH.bat`. Refresh the WebUI with `Ctrl+F5`, then check the plugin manager and both session-management routes. If the WebUI copy is stale, rerun `node tools/sync-to-profile.mjs` while DSH is stopped.

## Configuration rules

- Keep the `file:` dependency in both profile `package.json` files pointed at the canonical source path.
- Keep `cordis.patch.yml`, `dsh-plugin.json`, `package.json`, and `dist` together in the source repository.
- Keep Feishu credentials and session state in `C:\Users\18019\.dsh-lark`; never copy secrets into this repository.
- Keep archived sessions and deleted sessions in their separate cold-storage directories. Do not delete either directory during plugin maintenance.
- Use `E:\DSHspace\临时` only for disposable task artifacts and remove those artifacts after each task.

## Basic verification

```powershell
Invoke-WebRequest 'http://127.0.0.1:3080/dsh-plugin-manager/list'
Invoke-WebRequest 'http://127.0.0.1:3080/archived-sessions/sessions'
```

Both requests should return HTTP `200`. The fresh DSH error log should not show repeated `session-projection` reconnect failures.

## Rollback

Do not restore the removed legacy session plugins. They duplicated routes and can prevent the unified plugin tree from starting. For a source rollback, use the Git history in this repository; for runtime data rollback, use the timestamped snapshots under `E:\DeepSeekHarness\backups`.