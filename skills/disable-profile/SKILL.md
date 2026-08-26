---
name: disable-profile
description: Disable the active Sandbox Extender profile for the current coding-agent thread. Use when the user asks to deactivate, disable, or turn off a Sandbox Extender profile.
---

# Disable a profile

Disable the active profile only for the current coding-agent thread.

1. Use `$HOME_FOLDER/.agents/sandbox-extender` as the policy repository.
2. Submit `bun run authorize:mutation -- disable_profile --thread-id <current-host-thread-id>` through the host's shell tool immediately before the MCP call. Require explicit user approval for this command, even if the host could run it without prompting. Wait for it to succeed. If the host cannot request approval for a shell command, ask the user to run it instead.
3. Call the `sandbox-extender` MCP tool `disable_profile` with that host thread ID before the authorization expires.
4. State that the thread no longer has an active Sandbox Extender profile. The coding host's normal approval behavior remains unchanged.

Do not edit the policy repository as part of deactivation.
