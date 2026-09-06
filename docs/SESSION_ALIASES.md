# Session aliases

The Feishu bridge exposes stable `MMDD-N` aliases for native DSH sessions.
The alias map is stored at `<workspace>/.session_aliases.json` with mode `0600`.
It contains only alias-to-session-id pairs; DSH session logs and projection data remain owned by DSH.

## Commands

- `/sessions` lists regular DSH sessions, their aliases, titles, state, and native IDs.
- `/new` interrupts current tasks, creates a native Web session, stores it as the current session, and returns its alias.
- `/use 0905-1` opens the existing DSH binding confirmation card. The session must belong to the current workspace.
- `/delete 0905-1` opens a confirmation card and moves the session to the recoverable recycle bin.
- `/purge 0905-1` opens a separate destructive confirmation card and permanently removes the session.

Aliases are assigned in local calendar time. Existing aliases are never renumbered when another session is deleted; a new session uses the next number currently present for that date.

## Safety and recovery

Delete cards are one-shot and expire after ten minutes. Card actions validate the operator, chat scope, workspace, alias mapping, and current session existence before changing lifecycle state.

Normal deletion uses the local Web adapter endpoint to enter the recycle bin; the bridge clears its local session binding and projection binding but keeps the alias. Permanent purge removes the native record and then removes the alias. If a session was deleted from the DSH Web UI, `/sessions` removes its stale alias on the next successful refresh.

The bridge still uses the existing WebSocket mux for live session projection. No public IP, inbound port, or alternate session store is required.

## Hot reload

Build the plugin and use the DSH hot-installer when it is installed. If the active profile has no hot-installer, reinstall the local package into that profile and restart DSH; do not delete `.session_aliases.json` during reload because it is the durable alias state.
