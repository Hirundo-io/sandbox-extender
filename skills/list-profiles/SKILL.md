---
name: list-profiles
description: List reviewed Sandbox Extender profiles that can be activated. Use when the user asks which profiles are available, installed, or ready to activate.
---

# List profiles

Call the `sandbox-extender` MCP tool `list_profiles`. It is read-only and does
not initialize or modify the policy repository.

Report the returned Profile IDs exactly. The tool verifies each candidate's
stored contents against its reviewed revision before returning it. If the
result is empty, say that no activatable reviewed profiles are available under
`$HOME_FOLDER/.agents/sandbox-extender/profiles`. Do not treat proposals,
bundled templates, or an active thread binding as activatable Profiles.

Use `sandbox-extender:activate-profile` only when the user explicitly asks to
activate a named Profile.
