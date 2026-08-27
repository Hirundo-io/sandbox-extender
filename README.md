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

Profile mutations require a separate user authorization created by the CLI,
not the plugin's MCP server. Each authorization names the host thread, the
exact MCP operation, and a SHA-256 digest of the operation's canonical
arguments. The artifact and CLI output do not retain or echo the arguments. It
expires after two minutes and can be claimed only once. Create it immediately
before the matching MCP call:

```sh
bun run authorize:mutation -- <operation> \
  --thread-id <host-thread-id> \
  --arguments-json '<operation-arguments-without-threadId>'
```

For example, authorize one activation with:

```sh
bun run authorize:mutation -- activate_profile \
  --thread-id <host-thread-id> \
  --arguments-json '{"arguments":{"repository":"owner/repository","pullRequest":42},"profileId":"babysitter"}'
```

Use `{}` or omit `--arguments-json` for
`initialize_policy_repository` and `disable_profile`. The other argument
objects match their MCP inputs with `threadId` removed. Run the command with
`--help` to see each operation's shape. A mismatched, malformed, or expired
authorization fails closed and is consumed, so create a new one before
retrying. The agent can still evaluate requests without a mutation
authorization.

The disabled `shared/profile-templates/scout.json`,
`shared/profile-templates/maker.json`, and
`shared/profile-templates/babysitter.json` files are Profile templates. Their
`pending-review` revision prevents activation until you copy, scope, review,
and promote them. A Profile template is not itself a Cedar policy or an active
Profile. It contains the Profile's target scope, ordered groupings, Cedar
policies, session guidance, and optional reviewed executable components.

Profile activation accepts explicit arguments. Babysitter accepts a repository
and pull-request number, Maker accepts an absolute workspace, and Scout accepts
an explicit target set. The Activation Materializer validates those arguments
and freezes its targets into the thread binding. Promotion reviews reusable
rules and materializer code; it does not choose a target.

Request Materializers parse shell or MCP input into typed facts for Cedar. They
may reject malformed input, but they do not allow or deny operations. Cedar is
the only authorization language. The bundled implementations live under
`shared/materializers/requests/`, while activation implementations live under
`shared/materializers/activation/`.

Materializers are Profile-owned, engineer-reviewed executable code. Approving
their Policy Revision approves them to run with the user's authority. They are
not runtime-sandboxed. Activation verifies each materializer reference and its
current source bytes against the reviewed Git commit. Missing or changed code
makes activation or evaluation fail closed.

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
