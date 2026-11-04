# Paseo compatibility notes

These are the Paseo facts a current run depends on: the ones `workloop.mjs` does not absorb for you, because they change what you do. Paseo changes quickly, and a version this file does not name is unverified.

- **Windows.** The CLI is a `.cmd` shim, which Node can only start through a shell. Set `PASEO_CLI` to the CLI's `.js` entry point to bypass the shell.
- **Permissions.** `paseo permit ls` lists a worker's pending requests, and `paseo permit allow <agent> [req]` / `paseo permit deny <agent> [req]` answer them: the orchestrator answers, never the worker. Whether an agent pauses for approval depends on the provider. Opencode and the ACP providers (copilot, cursor, kimi, kiro, trae) wait on every permission request, because the CLI cannot pass their `auto_accept`; Claude and Codex set it through the mode, which the CLI does pass; Pi asks only when an extension opens a dialog.
- **Agent profiles.** The app keeps them in `$PASEO_HOME/config.json` (default `~/.paseo`) under `daemon.agentProfiles`, as `{id, name, provider, model?, modeId?, thinkingOptionId?, featureValues?, notes?}`; the `list_profiles` MCP tool serves the same list, and the script reads the file directly. If `PASEO_HOST` is set, the daemon's file is on another machine, so it reads nothing and the run needs `--provider`.
- **Profile features.** A prepared MCP request keeps the profile's `featureValues` (such as Codex `fast_mode`); the CLI cannot pass them, which is why every launch is a prepared MCP request.
- **`agent ls`.** It lists only the current directory's agents unless you pass `-g`, so add `-g` when you look one up by label.

Read [paseo-compat-history.md](paseo-compat-history.md) when re-verifying after a Paseo upgrade: it holds the dated observations, every old CLI shape, and the commands to check them again.
