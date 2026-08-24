# Run a local policy core service with host bridges

Sandbox Extender runs a persistent local Policy Core service, accessed by a CLI and Agent Host-specific bridges. The core evaluates Cedar, maintains local thread/Profile state, logs decisions, and issues single-use decision tokens; a bridge executes an allowed request in its host's existing environment, preserving its working directory, credentials, and MCP connection without turning the extender into a second sandbox.
