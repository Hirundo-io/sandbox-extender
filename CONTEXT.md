# Sandbox Extender

Sandbox Extender is a developer tool for making agent permissions predictable and reusable across supported coding-agent hosts. It extends, rather than replaces, the host's normal approval sandbox with user-authored, reviewable rules.

## Language

**Approval**:
A user decision that permits a specific agent action under the host's existing permission mechanism.
_Avoid_: Consent, confirmation

**Capability Rule**:
A fixed, readable rule that determines whether a requested agent action may proceed.
_Avoid_: Auto-mode, permission heuristic

**Extension**:
An approval granted by a Capability Rule for an action the Agent Host would otherwise ask the human to approve. It never broadens the Agent Host's ordinary workspace permissions or overrides a host denial.
_Avoid_: Sandbox replacement, full access

**Profile**:
A named, user-activated grouping of capability rules for a defined kind of work and a bounded target.
_Avoid_: Mode, policy bundle

**Active Profile**:
The sole Profile governing approvals for one agent thread at a time.
_Avoid_: Session profile, combined profile

**Target**:
The explicitly bounded resource scope to which a Profile applies, such as one repository or one GCP project.
_Avoid_: Environment, workspace

**Policy Repository**:
The user's Git repository at `.agents/sandbox-extender` that is the local source of truth for Capability Rules, groupings, Profiles, and their tests. It may optionally have a remote clone for replication.
_Avoid_: Policy database, central service

**Policy Proposal**:
A developer-approved change to the Policy Repository, potentially authored by an agent from observed approval history. A proposal has no effect until its policy changes are explicitly approved.
_Avoid_: Learned policy, automatic update

**Policy Revision**:
The specific committed state of the Policy Repository used to evaluate a Profile. A changed Active Profile must be explicitly re-activated against its new Policy Revision.
_Avoid_: Latest policy, live policy

**Context Lookup**:
Profile-owned code that derives bounded, trusted facts needed for policy evaluation, such as the current repository, branch, active cloud project, or current pull request. It is versioned and reviewed with the Profile rather than generated at evaluation time.
Approving a lookup resolver approves trusted executable code that runs with the user's authority; it is not runtime-sandboxed.
_Avoid_: Dynamic policy code, arbitrary evaluation command

**Extension Decision**:
The extender's allow, deny, or abstain result for an approval request. An allow executes the request; a deny blocks it; an abstain leaves the request to the Agent Host's normal approval prompt.
_Avoid_: Recommendation, advisory decision

**Cedar Policy**:
The declarative authorization policy evaluated against a normalized request and Profile-owned context. Cedar is the sole policy language used by Sandbox Extender.
_Avoid_: Rego policy, user-selected policy language

**Rule Order**:
The explicit sequence of Rules and rule groupings within a Profile. Profiles define an order and should avoid conflicting rules.
_Avoid_: Implicit precedence, most-specific match

**Thread Binding**:
The association between one Active Profile and one identifiable Agent Host thread. If the binding cannot be safely recognized after a resume, fork, rename, or move, the Profile is disabled.
_Avoid_: Session inheritance, profile carry-over

**Live Binding**:
A Profile argument whose target is resolved from the current trusted context at each evaluation rather than frozen at activation. Its meaning follows live state, such as the checked-out Git branch or active GCP project.
_Avoid_: Activation snapshot, pinned context

**Allowed Target Set**:
The set of Targets a Profile permits at evaluation time. A Live Binding may move among members of this set; changing context to a Target outside it does not extend authority.
_Avoid_: Unbounded live target, implied scope

**Target Set**:
A reusable, explicit collection of Target identifiers referenced by a Profile. Target Sets are the first supported way to share scope; provider-aware dynamic selection is deferred.
_Avoid_: Wildcard scope, implicit provider selector

**Adapter**:
Read-only typed code that normalizes shell-command or MCP-call input into the Cedar authorization model. It cannot execute the requested operation during evaluation.
_Avoid_: Tool executor, dynamic rule

**Executable Segment**:
One command within a shell structure that is independently normalized and authorized. A compound shell request abstains if any segment cannot be normalized.
_Avoid_: Compound-command allowance

**Authorization Test**:
An explicit expected allow, deny, or abstain case kept with a Profile. It complements audit-log replay by defining intended behavior at capability boundaries.
_Avoid_: Historical replay only

**Host Bridge**:
An Agent Host-specific integration that forwards observable approval requests to the policy core and executes an allow in the Host's existing environment. Its supported interception coverage is explicit and may be experimental.
_Avoid_: Universal hook, host-neutral executor

**Policy Core**:
The host-neutral local Bun/TypeScript service that owns Profile activation, thread bindings, Cedar evaluation, one-time decisions, and audit logging.
_Avoid_: Host plugin, execution sandbox

**Decision Token**:
A short-lived, single-use authorization record bound to one normalized request, its resolved live context, and its Policy Revision. It prevents an allow from being replayed for another request.
_Avoid_: Reusable approval, session grant

**Grouping**:
Code that scopes and orders related capability checks within a Profile. Groupings are evaluated by the Policy Core in Profile order; Cedar performs the individual capability check within a selected Grouping.
_Avoid_: Cedar grouping, implicit policy precedence

**Disabled Profile**:
The state of a Profile whose Policy Revision cannot be loaded, compiled, validated, or evaluated. A Disabled Profile makes every extension request abstain.
_Avoid_: Last-known-good auto-approval, degraded allow

**Audit Log**:
A user-editable YAML record of reasonably collectable evidence about extension decisions, excluding full chat history. Sensitive credentials are redacted by default.
_Avoid_: Conversation archive, security vault

**Agent Host**:
A coding-agent application that requests actions and delegates approval decisions to Sandbox Extender.
_Avoid_: Agent, assistant
