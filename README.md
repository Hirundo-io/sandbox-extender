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

## Profile mutation Approval

Profile mutations use MCP elicitation. Before changing the Policy Repository or
a Thread Binding, the Agent Host displays the exact operation, Profile, Policy
Revision, Activation Arguments, and Targets where they apply. The mutation runs
only after the host returns `accept` with the confirmation field set. `decline`,
`cancel`, malformed responses, and transport failures do not mutate anything.
This Approval is authorization for one operation, not identity authentication.

Clients without form elicitation use the compatibility CLI. Its authorization
names the host thread and operation and stores only a SHA-256 digest of the
canonical arguments. It expires after two minutes and can be claimed once.
Run it only after an MCP mutation reports that elicitation is unsupported, then
retry the unchanged MCP call:

```sh
bun run authorize:mutation -- <operation> \
  --thread-id <host-thread-id> \
  --arguments-json '<operation-arguments-without-threadId>'
```

For example:

```sh
bun run authorize:mutation -- activate_profile \
  --thread-id <host-thread-id> \
  --arguments-json '{"arguments":{"repository":"owner/repository","pullRequest":42},"profileId":"babysitter"}'
```

Use `{}` or omit `--arguments-json` for
`initialize_policy_repository` and `disable_profile`. The other argument
objects match their MCP inputs with `threadId` removed. Run the command with
`--help` to see each operation's shape. A mismatched, malformed, or expired
authorization fails closed and is consumed. Do not use the fallback after a
decline, cancel, or unrelated elicitation failure. Request evaluation remains
available without mutation Approval.

The disabled `shared/profile-templates/scout.json`,
`shared/profile-templates/maker.json`, and
`shared/profile-templates/babysitter.json` files are Profile templates. Their
`pending-review` revision prevents activation until you copy, scope, review,
and promote them. A Profile template is not itself a Cedar policy or an active
Profile. It contains the Profile's target scope, ordered groupings, Cedar
policies, session guidance, and optional reviewed executable components.

Profile activation accepts explicit arguments. Babysitter accepts a repository
and pull-request number. It can instead accept an absolute working directory
and resolve that workspace's current pull request with reviewed `gh` output.
Maker accepts an absolute workspace, and Scout accepts an explicit target set.
The Activation Materializer validates those arguments and freezes its targets
into the thread binding. Promotion reviews reusable rules and materializer
code; it does not choose a target.

Request Materializers parse shell or MCP input into typed facts for Cedar. They
may reject malformed input, but they do not allow or deny operations. Cedar is
the only authorization language. The bundled implementations live under
`shared/materializers/requests/`, while activation implementations live under
`shared/materializers/activation/`.

Materializers are Profile-owned, engineer-reviewed executable code. Approving
their Policy Revision approves the exact source artifact, Deno runtime version,
and data-only permission manifest. Sandbox Extender runs them with the
repository-local Deno 2.8.1 binary, `--no-prompt`, frozen and cached-only
dependency settings, the actual request working directory, a five-second
timeout, and 64 KiB stdout and stderr limits. It rejects relative, package, and
dynamic imports, so the integrity digest covers the complete self-contained
source plus the canonical manifest and runtime version.

The manifest has explicit arrays for `read`, `write`, `env`, `net`, `sys`,
`run`, and `ffi`. Policy Core turns those values into Deno flags. Profile JSON
contains references and data only. `run` and `ffi` are high-authority grants.
A permitted subprocess keeps its normal OS credentials, filesystem access, and
network access; Deno's other flags do not sandbox that subprocess.

These permissions describe the materializer process, not the request that
Cedar may authorize afterward. A materializer that parses a `gh` command needs
no `run` or `net` permission. A materializer that calls `Deno.Command("gh")`
needs `run: ["gh"]`, but it still does not need `net`: the `gh` subprocess uses
its normal OS authority. Filesystem inspection through Deno or a `node:fs`
compatibility API needs an explicit `read` declaration.

Bun installs Deno as a production dependency. `package.json` lists `deno` as a
trusted lifecycle dependency because its official postinstall selects the
platform binary. No other package receives lifecycle trust.

### Supported shell subset

Shell requests use the Bash grammar by default and accept the shared POSIX `sh`
subset. The compiler authorizes every concrete segment in ordinary sequences,
pipelines, `&&` and `||` chains without ambiguous state changes, brace groups,
safe subshells, finite literal `for` loops, and simple `while` or `until` loops.
Finite loops resolve quoted variables and safe unquoted variables into concrete
arguments. Capability Rules receive the loop kind, condition or body role,
iteration number for finite loops, and whether repetition is finite or
potentially unbounded.

The whole request abstains on `if`, `case`, functions, arithmetic control flow,
dynamic command names, assignments, command or process substitution, unsafe
parameter expansion, redirection, background execution, ambiguous conditional
`cd`, shell-state mutation that cannot be modeled, parse errors, or expansion
limits. Zsh is not part of the contract because the repository has no Zsh
fixtures.

### Reviewed `gh` Context Lookup example

Babysitter's
[`shared/materializers/activation/github-pull-request.ts`](shared/materializers/activation/github-pull-request.ts)
runs `gh pr view --json number,url` when activation receives
`{"workingDirectory":"/absolute/current/workspace"}` instead of an explicit
repository and pull-request number. It validates the returned GitHub URL and
number before freezing one canonical pull-request Target. Its Profile uses this
data-only declaration:

```json
{
  "file": "materializers/activation/github-pull-request.ts",
  "integrity": "e4ef39eef56adf7ccc91f21229c8059991ddb012bfdf24ba6f33fb9eaf313059",
  "language": "typescript",
  "permissions": {
    "read": [], "write": [], "env": [], "net": [], "sys": [],
    "run": ["gh"], "ffi": []
  },
  "runtimeVersion": "2.8.1"
}
```

The `gh` process retains normal OS authority. Review the command and its output
validation before accepting that `run` declaration.

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
