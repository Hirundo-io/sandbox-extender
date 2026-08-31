---
name: disable-profile
description: Disable the active Sandbox Extender profile for the current coding-agent thread. Use when the user asks to deactivate, disable, or turn off a Sandbox Extender profile.
---

# Disable a profile

Disable the active profile only for the current coding-agent thread.

1. Use `$HOME_FOLDER/.agents/sandbox-extender` as the policy repository.
2. Call the `sandbox-extender` MCP tool `disable_profile` with that host thread ID. Continue only after the Agent Host displays the exact operation, active Profile, Policy Revision, and Targets and reports that the user accepted it.
3. If the approval cannot be completed, report the MCP failure. Do not run the standalone CLI: agents mutate profiles only through MCP.
4. State that the thread no longer has an active Sandbox Extender profile. The coding host's normal approval behavior remains unchanged.

Do not edit the policy repository as part of deactivation.
