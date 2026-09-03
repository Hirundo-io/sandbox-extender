---
name: reinstall-sandbox-extender
description: Install or refresh the Sandbox Extender plugin from its main branch for local Codex and Claude Code, with optional additional SSH hosts. Use when a developer asks to install, reinstall, update, or sync Sandbox Extender.
---

# Install Sandbox Extender

Install or refresh Sandbox Extender from `https://github.com/Hirundo-io/sandbox-extender.git` at `main` for both Codex and Claude Code. The local machine is always a target. When the user names SSH hosts, treat each as an additional target; do not replace the local installation.

This skill manages the plugin only. Do not activate, alter, or remove Sandbox Extender Profiles or policy repositories.

1. Set the target list to the local machine plus the explicit SSH host aliases supplied by the user. Do not infer remote hosts from agent connections, Git remotes, or SSH configuration.
2. On each target, inspect Codex and Claude Code plugin and marketplace state before changing it. The expected marketplace source is `https://github.com/Hirundo-io/sandbox-extender.git` at `main` for Codex and `Hirundo-io/sandbox-extender` for Claude Code. If either executable is unavailable, report that target/tool as unavailable and continue with the other requested targets.
3. Register the Sandbox Extender marketplace when it is absent. Replace a local or different Git source before continuing:

   ```sh
   codex plugin marketplace add https://github.com/Hirundo-io/sandbox-extender.git --ref main
   claude plugin marketplace add https://github.com/Hirundo-io/sandbox-extender.git --scope user
   ```

   ```sh
   codex plugin marketplace remove sandbox-extender
   codex plugin marketplace add https://github.com/Hirundo-io/sandbox-extender.git --ref main
   claude plugin marketplace remove sandbox-extender
   claude plugin marketplace add https://github.com/Hirundo-io/sandbox-extender.git --scope user
   ```

   Refresh a correctly configured Git marketplace instead:

   ```sh
   codex plugin marketplace upgrade sandbox-extender
   claude plugin marketplace update sandbox-extender
   ```

4. Ensure the plugin itself is installed and enabled for the user. Install it when missing; otherwise refresh it:

   ```sh
   codex plugin add sandbox-extender@sandbox-extender
   claude plugin install sandbox-extender@sandbox-extender --scope user
   claude plugin update sandbox-extender@sandbox-extender
   ```

   Run only the appropriate install or update command for the observed state. Codex refreshes installed plugin contents through its marketplace upgrade; if its listing shows an installed but disabled plugin, run `codex plugin add sandbox-extender@sandbox-extender` to re-enable it. Do not remove an installed plugin merely to update it.

5. For an SSH target, read `~/.ssh/config` and accept only an exact, literal alias from a positive `Host` entry. Exclude wildcard and negated patterns, and reject a supplied target that is absent from this allowlist. Do not accept `user@host`, IP addresses, options, or other host syntax even if SSH could parse it. Pass the validated alias as one argument after `--` (for example, `ssh -- "$host" <fixed-command>`) and keep the remote command fixed rather than interpolating user input. Run the same checks and commands through that connection, one command at a time; stop mutating that host when its SSH connection or a required command fails, then continue with the remaining targets.
6. Verify each successful target with `codex plugin list` and `claude plugin list`. Confirm that `sandbox-extender@sandbox-extender` is installed and enabled for both tools. Versions can differ because Codex and Claude Code package the plugin metadata differently; enabled status and the marketplace source are the completion criteria.
7. Report the result by target and tool, including unavailable tools or failed targets. Mention any restart that either host reports as required. Do not claim an SSH host was updated unless its post-update listing confirms it.

Completion requires an enabled Sandbox Extender installation for every available requested tool on the local machine and every reachable explicit SSH host, or a clear report of the exact target/tool that could not be completed.
