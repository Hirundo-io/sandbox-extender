---
name: check-active-profile
description: Check the Sandbox Extender profile active for the current coding-agent thread. Use when the user asks whether a profile is enabled, active, or bound to this thread.
---

# Check the active profile

Call the `sandbox-extender` MCP tool `get_active_profile` with the current
coding host's thread ID. It validates the bound Profile against its reviewed
revision and binding fingerprint without changing the policy repository.

If the status is `inactive`, report that this thread has no active Sandbox
Extender profile. If it is `active`, report the exact Profile ID, Policy
Revision, and frozen `allowedTargets`. Those targets are the binding's scope,
not a promise that every future request will be authorized.

If the status is `stale`, report the binding as stale rather than active. If it
is `unavailable`, report that the policy repository could not be verified.

Do not activate, disable, initialize, repair, or remove a binding while
checking it.
