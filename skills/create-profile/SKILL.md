---
name: create-profile
description: Create a narrow Sandbox Extender profile proposal from an observed request. Use when the user asks to create, draft, or learn a permission profile. Do not use to activate a profile.
---

# Create a profile proposal

Create proposals from a concrete request the user wants to repeat. Do not generalize from a chat instruction or activate a proposal.

1. Use `$HOME_FOLDER/.agents/sandbox-extender` as the policy repository. Call `initialize_policy_repository` with the current host thread ID. Continue only after the Agent Host displays the exact mutation and reports that the user accepted it.
2. Use an observed request from `audit.yaml` when available. Otherwise, ask the user for the exact action, target resource, and arguments they want to cover.
3. Call `propose_profile` with the exact `action`, `arguments`, `profileId`, `resource`, and current host thread ID. Check that the Agent Host presents the same operation, Profile, and Target before the user accepts it.
4. Tell the user where the proposal and authorization tests were written. They must review both.
5. Only after the user explicitly confirms that review, call `promote_profile` with the exact `profileId`, `policyRevision`, and current host thread ID. Promotion does not activate the profile.

## Authoring materializers

When the Profile needs a new Activation or Request Materializer, inspect every
operation the materializer itself performs and declare only those Deno
permissions. Do this separately for the activation and request files. Do not
copy permissions from the command the Profile may later authorize.

- Add `read` or `write` only for filesystem access performed by the
  materializer. Use `$WORKING_DIRECTORY` and `$REQUEST_RESOURCE` when access is
  bound to those reviewed paths.
- Add `env`, `net`, or `sys` only when the materializer calls the corresponding
  Deno API. Parsing a `gh`, package-manager, or MCP request does not need network
  access.
- Add `run` only when the materializer constructs a `Deno.Command`. Name each
  permitted executable. A subprocess keeps its normal OS filesystem, network,
  and credential authority, so `run` is a high-authority declaration.
- Add `ffi` only for a reviewed `Deno.dlopen` call. Treat it as high authority.

Write production materializers against Deno APIs only. Keep Bun APIs out of
materializer source. For Bun unit tests, inject a narrow function around the
Deno operation or mock the relevant Deno API. Do not add a Bun runtime branch.

Before proposing or promoting the Profile, recompute integrity from the exact
self-contained source, canonical permission manifest, and reviewed Deno
version. Test one allowed and one denied case for every non-empty permission.
Confirm that plugin validation rejects the old digest or an undeclared access.

If a mutation reports that the host cannot complete its required approval retry, run `bun run authorize:mutation -- <operation> --thread-id <current-host-thread-id> --arguments-json '<exact-operation-arguments>'` through the host's explicit shell-approval path, then retry the unchanged MCP call before the authorization expires. Use `{}` for initialization. Do not use the fallback after decline, cancel, malformed retry data, or another interaction failure.

The proposal must remain target-bound and action-bound. Do not broaden it to similar commands, other repositories, or other tool calls.
