---
name: check-active-profile
description: Check the Sandbox Extender profile active for the current coding-agent thread. Use when the user asks whether a profile is enabled, active, or bound to this thread.
---

# Check the active profile

Read `$HOME_FOLDER/.agents/sandbox-extender/state/thread-bindings.json` without
changing it. If `HOME_FOLDER` is unset, use the current user's home directory.
Look up the current coding host's thread ID in the top-level object.

If no binding exists, report that this thread has no active Sandbox Extender
profile. Otherwise report the exact Profile ID, Policy Revision, and frozen
`allowedTargets` from the binding. Those targets are the binding's scope, not a
promise that every future request will be authorized.

Do not activate, disable, initialize, repair, or remove a binding while
checking it. A missing state file means there is no active Profile.
