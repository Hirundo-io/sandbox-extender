---
name: disable-profile
description: Disable the active Sandbox Extender profile for the current coding-agent thread. Use when the user asks to deactivate, disable, or turn off a Sandbox Extender profile.
---

# Disable a profile

Disable the active profile only for the current coding-agent thread.

1. Use `$HOME_FOLDER/.agents/sandbox-extender` as the policy repository.
2. Call the `sandbox-extender` MCP tool `disable_profile` with that host thread ID. Continue only after the Agent Host displays the exact operation, active Profile, Policy Revision, and Targets and reports that the user accepted it.
3. If the tool reports that the host cannot complete its required approval retry, submit `bun run authorize:mutation -- disable_profile --thread-id <current-host-thread-id>` through the host's explicit shell-approval path, then retry the same MCP call before the authorization expires. Do not use the fallback after decline, cancel, malformed retry data, or another interaction failure.
4. State that the thread no longer has an active Sandbox Extender profile. The coding host's normal approval behavior remains unchanged.

Do not edit the policy repository as part of deactivation.
