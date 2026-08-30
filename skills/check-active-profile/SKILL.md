---
name: check-active-profile
description: Check the Sandbox Extender profile active for the current coding-agent thread. Use when the user asks whether a profile is enabled, active, or bound to this thread.
---

# Check the active profile

Call the `sandbox-extender` MCP tool `get_active_profile` with the thread ID
that the host uses for `PermissionRequest` events. It validates the bound
Profile against its reviewed revision and binding fingerprint without changing
the policy repository.

For Claude Code, use `CLAUDE_CODE_SESSION_ID`, which is the hook `session_id`.
For Codex, use a thread ID supplied by the host for the current MCP session.
Do not assume `CODEX_THREAD_ID` is the `PermissionRequest` binding key unless
the host establishes that equivalence. If the required ID is unavailable or
cannot be verified, report that active-profile status cannot be checked rather
than reporting the thread as inactive.

If the status is `active`, report the exact Profile ID, Policy Revision, and
frozen `allowedTargets`. Those targets are the binding's scope, not a promise
that every future request will be authorized. If it is `inactive`, report that
this thread has no active Sandbox Extender profile.

If the status is `stale`, report the binding as stale rather than active. If it
is `unavailable`, report that the policy repository could not be verified.

Do not activate, disable, initialize, repair, or remove a binding while
checking it.
