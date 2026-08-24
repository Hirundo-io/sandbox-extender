---
name: create-profile
description: Create a narrow Sandbox Extender profile proposal from an observed request. Use when the user asks to create, draft, or learn a permission profile. Do not use to activate a profile.
---

# Create a profile proposal

Create proposals from a concrete request the user wants to repeat. Do not generalize from a chat instruction or activate a proposal.

1. Use `$HOME_FOLDER/.agents/sandbox-extender` as the policy repository. Before each state-changing MCP call, ask the user to run `bun run authorize:mutation -- <current-host-thread-id>` and pass that same `threadId` to `initialize_policy_repository`, then to `propose_profile`.
2. Use an observed request from `audit.yaml` when available. Otherwise, ask the user for the exact action, target resource, and arguments they want to cover.
3. Call `propose_profile` with a lowercase hyphenated profile ID and that exact request.
4. Tell the user where the proposal and authorization tests were written. They must review both.
5. Only after the user explicitly confirms that review, call `promote_profile` with the reviewed policy revision. Promotion does not activate the profile.

The proposal must remain target-bound and action-bound. Do not broaden it to similar commands, other repositories, or other tool calls.
