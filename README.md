# Sandbox Extender

Sandbox Extender adds user-owned, Cedar-backed approval extensions to Codex CLI and Claude Code. It only allows requests covered by an explicitly activated Profile; every missing, invalid, or out-of-scope policy state abstains and leaves the host's ordinary approval flow in control.

## Policy repository

Sandbox Extender always stores its policy repository at `$HOME_FOLDER/.agents/sandbox-extender`. If `HOME_FOLDER` is not set, it uses the current user's home directory. A Profile is JSON and uses an exact `allowedTargets` list plus ordered Cedar groupings.

```text
$HOME_FOLDER/.agents/sandbox-extender/
  profiles/
    review-current-pr.json
  state/
    thread-bindings.json
  audit.yaml
```

For example, this Profile allows only Codex shell requests from one workspace:

```json
{
  "id": "review-current-pr",
  "policyRevision": "your-reviewed-commit",
  "allowedTargets": ["/absolute/path/to/workspace"],
  "groupings": [
    {
      "id": "read-only-shell",
      "policies": {
        "allow-git-status": "permit(principal, action == Action::\"codex.unified_exec\", resource) when { context.arguments.command like \"git status*\" };"
      }
    }
  ]
}
```

Start by asking the agent to use the `sandbox-extender:create-profile` skill. It initializes the policy repository, writes a target-bound proposal under `proposals/`, and writes its authorization cases under `tests/`. Review those files, promote the proposal with an explicit policy revision, then activate it with `sandbox-extender:activate-profile`. Use `sandbox-extender:disable-profile` to remove the binding. The plugin writes observed extension requests and decisions to `audit.yaml` once the policy repository exists.

Profile mutations require a separate, one-time user authorization for the
relevant host thread. This authorization is intentionally created by the CLI,
not the plugin's MCP server, so an agent cannot mint its own permission to
change policy state. Before asking the agent to initialize, propose, promote,
activate, or disable a Profile, run:

```sh
bun run authorize:mutation -- <host-thread-id>
```

The next mutation for that exact thread consumes the authorization. The agent
can still evaluate requests without a mutation authorization.

The disabled `templates/scout.json`, `templates/maker.json`, and
`templates/babysitter.json` files are starting points only. Each has an empty
target set and a `pending-review` revision, so none can be activated until you
copy, scope, review, and promote it. Templates that name a resolver require
the matching file from `templates/resolvers/` to be copied to `resolvers/` in
the policy repository and are executed with Bun using JSON stdin/stdout.

## Development

```sh
bun test
bun run audit
bun run knip
bun run typecheck
bun run validate:plugin
claude plugin validate . --strict
```

GitHub Actions runs the locked install, audit, Knip, type check, and test
coverage on every pull request and change to `main`.

Codex discovers this repository through `.claude-plugin/marketplace.json`; install it locally with:

```sh
codex plugin marketplace add /absolute/path/to/sandbox-extender
codex plugin add sandbox-extender@sandbox-extender
```

For Claude Code development, load the plugin directly:

```sh
claude --plugin-dir /absolute/path/to/sandbox-extender
```
