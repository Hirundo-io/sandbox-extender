---
name: create-profile
description: Create pending-review Sandbox Extender profile proposals. Use observed-request creation for one narrow repeated request and complete-definition creation for parameterized profiles or reviewed templates. Do not use to activate a profile.
---

# Create a profile proposal

Choose the authoring operation before writing a proposal. Do not activate a proposal.

- Use `propose_profile` for one concrete observed request that must be repeated exactly.
- Use `propose_complete_profile` for a parameterized profile or when adopting a reviewed template. Supply the whole pending-review profile, every authorization test, and source for each new materializer. The service derives materializer paths from the validated profile ID and derives integrity from source, permissions, and runtime version.

For an exact observed request:

1. Use `$HOME_FOLDER/.agents/sandbox-extender` as the policy repository. Call `initialize_policy_repository` with the current host thread ID. Continue only after the Agent Host displays the exact mutation and reports that the user accepted it.
2. Use `audit.yaml` to identify an observed request when available, but treat its `resourceDisplay`, `resolvedTargetDisplay`, `resolvedTargetsDisplay`, and redacted argument values as display-only. Use the original Agent Host request for the exact action, target resource, and arguments. If that request is unavailable or any needed value was redacted, ask the user for the exact value; never copy a display-only or redacted value into a proposal.
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

If the MCP approval cannot be completed, report the failure. Do not run the standalone CLI: agents mutate profiles only through MCP.

The proposal must remain target-bound and action-bound. Do not broaden it to similar commands, other repositories, or other tool calls.

For a complete profile, write only a pending-review definition. Use an activation materializer when activation arguments must freeze a workspace, backend, repository, or similar target. Give the approval UI time to show the profile ID, every generated file, materializer permissions and integrity, and all tests. Review and commit those files before promotion with the exact full commit SHA. Never treat proposal creation as promotion or activation.
