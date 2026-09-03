# Sandbox Extender specification

## Purpose

Sandbox Extender reduces approval fatigue for software-engineering agents without replacing the host's normal approval sandbox. It makes repeated, bounded external capabilities reusable through readable, versioned policy code.

It extends only an action that the Agent Host would otherwise ask to approve. It never creates a broad “approve for me” or full-access mode and never overrides a host denial.

The initial Agent Hosts are Codex and Claude Code. Their bridges may have different, explicitly documented interception coverage.

## Non-goals

- Replacing an Agent Host's workspace sandbox or execution environment.
- Treating output/chat content as an input to a judging agent.
- Centrally administering policy for an organization.
- Automatically activating inferred policy changes.
- Storing full chat history or acting as a secrets vault.

## Architecture

```text
Agent Host
  └─ Host Bridge ── normalized request ──> Policy Core
       <── one-time allow / deny / abstain ──┘
  └─ executes an allow in its existing cwd, credentials, and MCP connection

Policy Core (local Bun/TypeScript service)
  ├─ active profile and thread binding
  ├─ ordered Groupings
  ├─ Cedar capability checks
  ├─ context lookups and target resolution
  ├─ audit log and replay tests
  └─ single-use, short-lived decision tokens
```

The Host Bridge executes an allowed request immediately. `allow` means run; `deny` means block; `abstain` returns control to the host's ordinary approval prompt.

## Policy repository

The source of truth is the local Git repository at `.agents/sandbox-extender`. It may be pushed to GitHub for replication across machines and VMs.

The repository contains:

- Cedar schemas and policies for individual capability checks.
- Typed TypeScript code for Profiles, Groupings, Target Sets, and Adapters.
- Read-only context-lookup code.
- Explicit authorization tests.
- Generated artifacts only where generation is deterministic and reproducible.

YAML is reserved for the editable audit log, not as a second policy language. Code must be readable and structured; documentation supplements code only where it adds information code cannot communicate.

Policy-repository writes always use the Agent Host's ordinary approval path. A Profile never grants authority to modify its own policy repository.

## Profiles

A Profile is a named, user-activated composition of Groupings for a defined kind of work and an Allowed Target Set.

- A thread has exactly one Active Profile.
- Only an Agent Host user Approval can activate or change one. MCP elicitation is primary; the short-lived local CLI artifact is a compatibility fallback for clients without elicitation.
- Agent text resembling `/profile` has no authority to change a profile.
- A profile is pinned to an exact approved Policy Revision.
- A changed active profile requires an explicit reactivation and notification.
- If a resume, fork, rename, or machine move cannot be safely matched to its thread binding, the profile is disabled.
- A missing, invalid, incompatible, or unavailable policy state disables the profile and makes every extension request abstain.

Disabled Profile templates may ship, but no Profile is active by default. Initial Profile templates are `Scout` for read-oriented external inspection and `Maker` for repository-scoped writes.

## Targets and live bindings

A Target is an explicitly bounded resource such as a repository, pull request, VM, or GCP project. A Target Set is a named reusable collection of explicit target IDs.

Profile parameters may be:

- **fixed**: a literal target supplied at activation; or
- **live**: a semantic selector resolved from trusted current state for every request, such as current Git repository, current branch, current PR, or active GCP project.

The UI must label fixed and live parameters distinctly. High-risk profiles may require confirmation of resolved defaults.

A Live Binding can change only within the Profile's Allowed Target Set. A `Deployed Debugger` may intentionally move among a declared set of GCP projects, including approved project-switching commands. A narrow profile cannot acquire a new target merely because the current local state changes.

## Evaluation

The Policy Core normalizes a request into Cedar's model:

- `principal`: the Agent Host thread;
- `action`: the normalized operation;
- `resource`: the resolved target; and
- `context`: validated arguments and trusted live facts.

Profiles contain explicitly ordered Groupings. The Policy Core evaluates Groupings in order. Each selected Grouping runs Cedar for individual capability checks and returns `allow`, `deny`, or `abstain`; the first decisive result wins. Later matching Groupings are logged as shadowed.

An allow produces a short-lived, single-use Decision Token bound to the normalized request, exact arguments, live context, and Policy Revision. It cannot be replayed for another request.

If required context cannot be resolved or is inconsistent with the request, evaluation abstains.

## Adapters and lookups

Request Materializers are typed normalization code. Profile-owned TypeScript materializers are reviewed with the Policy Repository. Approving a Policy Revision approves their complete self-contained source artifact, exact Deno runtime version, and canonical data-only permission manifest. Policy Core generates Deno flags for read, write, environment, network, system, subprocess, and foreign-function access. It verifies integrity and the repository-local runtime version before every non-interactive execution, uses the request working directory, and bounds time and output. Materializers must not execute the requested operation during authorization.

- The Bash and POSIX `sh` compiler independently authorizes every concrete Executable Segment in the supported sequence, pipeline, compound, loop, and static-function subset. Finite literal `for` loops and literal calls to top-level functions expand into bounded concrete arguments; functions support `$1` through `$9` and reject recursion or unmodeled function behavior. Simple `while` and `until` conditions and bodies expose potentially-unbounded repetition facts. Unsupported conditionals, dynamic construction, substitution, redirection, and unmodeled shell-state mutation make the full request abstain. Zsh remains unsupported until it has fixtures.
- MCP adapters use server identity, tool name, JSON-schema-validated arguments, and declared target extractors. Servers or tools lacking an adapter abstain.
- Context lookups are read-only and versioned as part of the Profile. They may resolve facts such as the PR for the current repository and branch.

`run` and `ffi` are high-authority declarations. A permitted subprocess retains normal OS authority outside Deno's other permission checks, so Profiles must name and review each permitted executable.

## Learning, approval, and testing

The system starts with no active policy. It observes every approval-related event a bridge can reliably see, labelled by source: extension, host approval, host denial, or unobserved.

The analysis workflow can cluster observations, propose capability rules, produce code changes, and generate tests. It may edit a policy proposal, but activation requires:

1. approval of the Policy Repository diff; and
2. explicit activation or reactivation of the Profile at that Policy Revision.

Each policy change is checked against historical accepted and rejected calls. Any old rejection becoming an allow is reported as a privilege expansion. Explicit Profile tests define expected allow, deny, and abstain behavior, especially at target-set, live-binding, and compound-command boundaries.

AutoCedar is inspiration, not a dependency: adopt its reviewed drafting, validation, synthesis, and artifact discipline only where useful in an engineer-ready product.

## Audit log

The audit log is a local, editable YAML file. It records every reasonably collectable tool-call fact: normalized request, decision, matched/shadowed rules, resolved profile and parameters, policy revision, lookup evidence, timestamps, and redacted output summaries.

It does not store full chat history or full output by default. Passwords and API keys are redacted by default. The underlying disk is expected to be encrypted; policy sharing is an intentional user decision.

## Host bridges

Each bridge has an explicit coverage declaration. It forwards only the approval requests it can reliably observe, passes output through normally, and runs an extension allow in the host's existing environment.

The first acceptance workflow is **GitHub comment on the current pull request**:

1. Start with no active profile.
2. Observe a normal approval for a GitHub PR comment.
3. Propose a current-repository/current-branch lookup, target-bound PR-comment capability, Cedar policy, and tests.
4. Review the diff and activate the Profile.
5. Automatically allow a later comment only on the current resolved PR; abstain or deny outside that scope.

## Implementation choice

Implement the Policy Core in TypeScript on Bun, using Cedar's WebAssembly interface. Host bridges use the language and integration surface best suited to each host.

Before claiming a bridge is supported, implementation must validate its interactive approval interception behavior against the current host API. Claude Code documents a permission-prompt MCP facility for its non-interactive/SDK path; Codex coverage must be independently confirmed.
