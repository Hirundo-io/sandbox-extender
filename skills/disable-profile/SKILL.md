---
name: disable-profile
description: Disable the active Sandbox Extender profile for the current coding-agent thread. Use when the user asks to deactivate, disable, or turn off a Sandbox Extender profile.
---

# Disable a profile

Disable the active profile only for the current coding-agent thread.

1. Use `$HOME_FOLDER/.agents/sandbox-extender` as the policy repository.
2. Call the `sandbox-extender` MCP tool `disable_profile` with the current host thread ID.
3. State that the thread no longer has an active Sandbox Extender profile. The coding host's normal approval behavior remains unchanged.

Do not edit the policy repository as part of deactivation.
