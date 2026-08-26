---
name: create-profile
description: Create a narrow Sandbox Extender profile proposal from an observed request. Use when the user asks to create, draft, or learn a permission profile. Do not use to activate a profile.
---

# Create a profile proposal

Create proposals from a concrete request the user wants to repeat. Do not generalize from a chat instruction or activate a proposal.

1. Use `$HOME_FOLDER/.agents/sandbox-extender` as the policy repository. Immediately before `initialize_policy_repository`, submit `bun run authorize:mutation -- initialize_policy_repository --thread-id <current-host-thread-id>` through the host's shell tool. Require explicit user approval for this command, even if the host could run it without prompting. Wait for it to succeed, then pass the same `threadId` to the MCP call. If the host cannot request approval for a shell command, ask the user to run it instead.
2. Use an observed request from `audit.yaml` when available. Otherwise, ask the user for the exact action, target resource, and arguments they want to cover.
3. Before `propose_profile`, submit `bun run authorize:mutation -- propose_profile --thread-id <current-host-thread-id> --arguments-json '<exact-propose-arguments>'` through the same explicit-approval flow. The JSON object must contain the exact `action`, `arguments`, `profileId`, and `resource` for the MCP call, without `threadId`. Wait for the command to succeed, then call `propose_profile` with that intent. Fall back to asking the user to run it only when the host cannot request approval.
4. Tell the user where the proposal and authorization tests were written. They must review both.
5. Only after the user explicitly confirms that review, submit the `promote_profile` authorization command through the same explicit-approval flow, with the exact `profileId` and `policyRevision` in `--arguments-json`. Wait for it to succeed, then call the MCP operation with the same values and current host thread ID. Fall back to asking the user to run the command only when the host cannot request approval. Promotion does not activate the profile.

The proposal must remain target-bound and action-bound. Do not broaden it to similar commands, other repositories, or other tool calls.
