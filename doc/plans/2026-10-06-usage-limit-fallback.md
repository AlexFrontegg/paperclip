# 2026-10-06 Usage-Limit Fallback

Status: Implemented (v1)
Date: 2026-10-06
Related:
- `doc/plans/2026-04-06-smart-model-routing.md` (mentions a fallback model slot as the better long-term shape)
- `doc/connections/AI-CONNECTIONS.md`
- Upstream: issue #14721 (typed per-agent fallback chains), #11597, #14563, #10344; PRs #9367, #12123, #15066

Line references are to commit `4089ab5`.

## 1. Problem

When an agent's AI account hits its usage limit, the run fails with
`errorCode: "provider_quota"`. Paperclip then retries the same agent on the same
account once the limit resets, which can take 5 hours or more for a weekly limit. The work
stalls for that whole window, even when the company has another AI
subscription (for example Codex) that could continue right away.

Goals:

- When the primary account is out of quota, the agent keeps working on a
  configured fallback (different adapter and/or account) with no human action.
- The agent keeps its identity: same agent row, name, manager role, reports,
  routines, chat (Slack/GitHub) bindings and task assignments.
- It switches back to the primary automatically once the limit resets.
- Off by default; agents without a fallback behave exactly as today.

Non-goals (v1):

- Fallback chains longer than one hop.
- `paperclip_runner` (native runner) as primary or fallback.
- Carrying a provider's private session across providers (not possible; see §6).
- Fixing the quota classification bugs listed in §9 (separate PRs).

## 2. Alternatives considered

| Option | Why not |
|---|---|
| Reassign the issue to a backup agent (PR #9367) | A second agent must mirror instructions, skills, permissions and role; manager duties, routines and chat bindings stay with the original agent; visible ownership change. |
| Fallback account, same adapter only (PRs #15066, #12123) | Cannot move Claude Code work to Codex. #15066 also has open correctness issues. |
| Plugin | Plugins cannot change an agent's adapter (no agent-update capability) and the plugin API is alpha. |
| Harness with built-in fallback (Hermes, Pi extension, OpenClaw) | Replaces Claude Code; Hermes self-modifies skills and memory; Pi extensions are third-party and runs that recover are recorded as failed (#14479); OpenClaw needs a gateway server. |
| Change `agents.adapterType` while in fallback | Changing the adapter deletes task sessions and resets runtime state (`server/src/services/agents.ts:801-809`), and it would break recovery evidence. |

## 3. Design overview

The fallback is a **per-run lane**, not a change to the agent:

1. The agent stores an optional fallback target in `runtimeConfig.usageLimitFallback`.
2. When a run on the primary lane fails with `provider_quota`, the retry scheduler
   activates the fallback for the agent until the primary's reset time and
   schedules the retry immediately instead of at the reset time.
3. When a run is claimed, the lane is decided once and recorded in the run's
   immutable `runnerProfileJson.adapterDispatch`.
4. At execution, an in-memory "effective agent" overlays the fallback
   `adapterType`, `adapterConfig` and `aiConnection`. Nothing is written to the
   agent row.
5. Once the reset time passes, the next claimed run uses the primary lane again.

## 4. Configuration

New optional key in `agents.runtimeConfig` (the schema already accepts extra keys,
`packages/shared/src/validators/agent.ts:72-85`). It gets its own strict sub-schema:

```ts
usageLimitFallback?: {
  enabled: boolean;
  adapterType: "claude_local" | "codex_local";   // v1 allow-list
  adapterConfig: {                               // engine-specific keys only (strict)
    model?, effort?, modelReasoningEffort?, fastMode?, search?, chrome?,
    maxTurnsPerRun?, dangerouslySkipPermissions?,
    dangerouslyBypassApprovalsAndSandbox?, networkAllowlist?
  };
  aiConnection?: AiConnectionBinding;            // validated for the fallback adapter
  switchBack: "on_reset";                        // v1: only option
}
```

- The fallback may use the same adapter as the primary with a different account
  (for example a second Claude subscription or an Anthropic API key), or a
  different adapter (Claude Code → Codex).
- The fallback can never set paths, commands, env or workspace settings; those
  always come from the primary. That keeps the agent-key guards on the primary
  config (no host workspace commands, no instruction paths) the only way to set
  them, and keeps secrets out of the fallback block.
- Effective fallback `adapterConfig`:
  - same adapter (a second account): the whole primary config plus the fallback
    keys, so permissions, turn caps and commands stay as configured;
  - another adapter: the shared keys (`paperclipSkillSync`, instructions keys,
    `cwd`, workspace, env, confinement, timeouts) plus the fallback keys. The
    primary's provider credentials, homes and routing (`AI_AUTH_ENV_KEYS`) are
    removed from the inherited env.
- Saving applies the adapter's create defaults to the fallback keys, so a Codex
  fallback gets `dangerouslyBypassApprovalsAndSandbox` like a new Codex agent;
  the UI shows that setting explicitly.

Validation on create, hire and update (`routes/agents.ts:4636, 4885, 5562-5570`):

- The fallback adapter must be in the v1 allow-list and selectable
  (`assertSelectableAdapterType`).
- `isAiConnectionCompatible` and `validateManagedAgentBinding(...fallback.adapterType...)`
  must pass for the fallback binding whenever the fallback is enabled, including
  when a fallback saved as disabled is turned on. Create and hire install the
  fallback account for the new agent, like the primary account.
- A PATCH that omits `usageLimitFallback` preserves it, like `aiConnection`
  (`routes/agents.ts:5562`).

## 5. Runtime behaviour

### 5.1 State

The state lives in `agent_runtime_state.stateJson.usageLimitFallback`
(`packages/db/src/schema/agent_runtime_state.ts:12`). It is one row per agent, and nothing
reads `stateJson` today, so no migration is needed.

```ts
{ activeUntil: ISODate, activatedAt: ISODate, sourceRunId: string,
  primaryAdapterType: string, fallbackAdapterType: string, reason: "provider_quota" }
```

Writes are atomic (`jsonb_set`, keeping the later `activeUntil`), because an agent can
run up to 20 runs at once and two quota failures can race.

`stateJson` is already reset when a session reset has no task key
(`heartbeat.ts:30141-30143`) and when the adapter changes
(`agents.ts:807`). Both resets clear the fallback. That is acceptable: the next
run tries the primary and re-activates the fallback if the primary is still limited.

### 5.2 Activation

The decision point is `scheduleBoundedRetryForRun`, where the provider reset time
currently pushes the retry due time (`heartbeat.ts:15552-15566`). It is the shared
path for heartbeat finalize, the recovery issue monitor and restart sweeps.

Activation requires all of the following:

- The failed run's error family is `provider_quota`.
- The failed run ran on the primary lane, according to its `adapterDispatch`.
- `usageLimitFallback.enabled` is true and the configured target still validates.

When it activates:

- Write the state with `activeUntil` = the run's `providerQuotaRetryNotBefore`. If
  that is missing, use now + 1h (the same default recovery uses today,
  `recovery/service.ts:530`).
- Keep the normal short retry delay instead of `retryNotBefore`, and mark the
  retry context `usageLimitFallback: true`.
- Log a run event and an `agent.usage_limit_fallback_activated` activity entry.
  No issue comment is posted: a comment authored by the agent could wake
  watchers or be published to a chat channel. The agent header shows the
  state instead (§7).
- If the fallback account cannot be selected right now, the fallback is not
  activated; the retry waits for the reset as before, and a run event records
  why.

A `provider_quota` failure on the fallback lane follows today's behaviour, which is
to wait for its own reset. It never re-activates or extends the fallback.

### 5.3 Lane selection at claim

`claimQueuedRun` (`heartbeat.ts:17363`, dispatch writes at 17753/17852/17919)
records the lane:

```ts
adapterDispatch: { adapterType, lane: "primary" | "fallback",
                   primaryAdapterType, fallbackUntil? }
```

- Lane = `fallback` if the state is active (`now < activeUntil`), not suspended,
  the fallback is configured and enabled, and this run's responsible user can use
  its AI account. Otherwise the lane is `primary`.
- An expired state or a changed config is cleared here; this is the switch-back.
  A suspended state, or an account this run's user cannot use, sends only this
  run to the primary and leaves the agent's state in place, so one run cannot
  flip the whole agent.
- The lane is fixed for the life of the run, including hot restarts. A retry is
  a new run, so its lane is decided again at its own claim.

### 5.3a When the fallback itself cannot run

A fallback-lane run that fails with `configuration_incomplete` or an AI sign-in
failure suspends the fallback for the rest of the window (`suspendedReason`).
Its retry is scheduled for `activeUntil`, the primary's reset, so the agent
waits as it would without a fallback instead of failing every run or
escalating to the board. A suspended state is not reactivated until it expires.

### 5.4 Execution

Right after `getAgent` in `executeRun` (`heartbeat.ts:20489`), build an
`effectiveAgentForRun(agent, run)` that overlays `adapterType`, `adapterConfig`
and `runtimeConfig.aiConnection` for fallback-lane runs. `executeRun` reads
`agent.*` about 50 times, so shadowing the variable is the single safe point.

The adapter guard at `heartbeat.ts:20507-20510` compares the claimed adapter
with the effective agent's adapter, not the raw agent row:

- If the claim says `fallback` but the fallback was removed or disabled
  before execution, the guard keeps today's error.

### 5.5 Sessions

- Task sessions are keyed by adapter type
  (`packages/db/src/schema/agent_task_sessions.ts:40-45`). A fallback run never
  resumes the primary's session. It starts fresh with the existing issue handoff
  (`getFreshSessionHandoff`, `heartbeat.ts:21867-21889`) and the issue's
  Continuation Summary document.
- Close two cross-adapter gaps:
  - Agent-wide `runtime.sessionId` (used when there is no task key,
    `heartbeat.ts:23045-23050`): only use it when `agentRuntimeState.adapterType`
    matches the run's effective adapter.
  - Explicit resume params from a prior run (`heartbeat.ts:27112-27123`): drop
    them when the prior run's lane adapter differs from this run's.
- After a fallback turn, the primary's task session for that task is cleared,
  so the primary resumes fresh with the handoff after the switch-back.
- A new activation (not an extension) clears the fallback adapter's task
  sessions, so a later window never resumes a conversation that misses the
  primary's turns since. A user session reset clears the task's sessions for
  every adapter.
- A fallback run with no managed account drops the primary's account
  attribution that the retry copied, and sign-in recovery resolves the account
  through the run's lane, so a fallback sign-in failure never marks the
  primary's account for reconnection.
- `updateRuntimeState` (`heartbeat.ts:19985`) records the effective adapter
  together with the session id, so the guard above stays correct.

### 5.6 Run display and attribution

- Live and issue run lists return the run's dispatched adapter, falling back to
  the agent row for older runs. Run list and run detail responses also carry
  `dispatchedAdapterType`, which the agent page's log viewer uses, so fallback
  runs render with the fallback adapter's parser.
- Costs already record provider, model and biller from the adapter result
  (`heartbeat.ts:19948-20022`). Fallback runs are attributed to the fallback
  account through `context.aiConnection` when a binding is set.

### 5.7 Chat (Slack/GitHub)

- Chat conversations are not locked to an adapter. Continuation reads the run's
  claimed adapter (`conversation-continuation.ts:23-54`), and both `claude_local`
  and `codex_local` are conversation adapters. A switch mid-conversation is a new
  provider session plus the normal handoff, under the same bot identity.
- GitHub chat readiness checks only the primary adapter
  (`chat-github-management.ts:478`); that is acceptable for v1.

## 6. What carries over and what does not

| Carries over | Lost on switch |
|---|---|
| Issue description, comments, documents, linked and sub-issues | The provider's private conversation for the run that hit the limit |
| Continuation Summary (`issue-continuation-summary.ts`, up to 8,000 chars) | |
| Workspace files, branches, pushed commits, PRs | |
| Agent instructions, skills, permissions, role, chat bindings | |

Guidance: agents should keep progress in comments or the plan document, so a
switch loses little.

## 7. UI

- Agent config, Adapter section (`ui/src/components/AgentConfigForm.tsx`, after
  the AI connection field at :1661):
  - A "When usage limit is reached" block with an enable toggle.
  - A fallback adapter dropdown, limited to the allow-list.
  - The fallback account picker: reuse `AiConnectionField` with the fallback adapter type, without `legacy`.
  - A fallback model and effort, reusing `ModelDropdown` and `ThinkingEffortDropdown` with the fallback adapter type.
  - The text "Switches back when the primary limit resets".
- Saving goes through `buildAgentUpdatePatch` (`ui/src/lib/agent-config-patch.ts`)
  as part of `runtimeConfig`.
- Agent header (`ui/src/pages/AgentDetail.tsx`) shows "Usage limit reached:
  running on Codex until <time>" while active, with a "Return to <primary>"
  action (`POST /agents/:id/usage-limit-fallback/clear`, board only, logged as
  `agent.usage_limit_fallback_cleared`).
- Run cards and lists show the adapter actually used.

## 8. Testing

- Shared: schema tests for `usageLimitFallback` (strict, allow-list).
- Routes (`server/src/__tests__/agent-hire-ai-connections.test.ts` pattern): valid
  and invalid fallback adapter, incompatible binding rejected on save, PATCH
  preserving the field.
- Heartbeat, embedded Postgres (`heartbeat-issue-rewake-throttle.test.ts` pattern):
  - A quota failure on the primary activates the fallback; the retry runs
    immediately on the fallback lane with the effective adapter, config and binding.
  - No fallback configured: today's behaviour, with the retry at the reset time.
  - A quota failure on the fallback lane: normal wait, no re-activation.
  - Expired state: the next claim uses the primary and clears the state; the primary session is fresh after fallback runs.
  - Two concurrent quota failures: one state, the later `activeUntil` wins.
  - The adapter guard accepts the claimed fallback, and rejects a run whose fallback was removed.
  - The agent-wide session and explicit resume are not used across adapters.
  - Run list APIs return the dispatched adapter.
- UI: config block render and patch test; header badge.

## 9. Known limitations and related bugs (not fixed here)

- The fallback triggers only when the failure is classified as `provider_quota`:
  - Claude ACP quota errors that arrive outside a typed `limit` failure end up
    as `acpx_turn_failed` (#14563, partly fixed).
  - Weekly resets that include a date are not parsed, so `activeUntil` defaults
    to +1h. The agent then tries the primary every hour; each try costs one
    failed run before the fallback re-activates.
- The reset time does not gate new runs (#11597), and the recovery monitor can
  loop after `retry_exhausted`. Both apply to agents without a fallback.
- Follow-up (v1.1): probe the primary's usage (`probeAiConnectionUsage`,
  `ai-connection-usage.ts:331`) for subscription connections. That allows
  switching back early, and setting `activeUntil` from the real weekly reset time.

- A fallback to a second account on the same adapter shares that adapter's
  task sessions. A session from the other account cannot be resumed, so the
  adapter retries with a fresh session, which costs one attempt.
- Activation happens only in the bounded transient retry path: a quota failure
  after its retry budget is used up waits for the reset, and switching uses one
  of the two bounded attempts.
- A fallback-lane quota failure waits for the fallback's own reset even if the
  primary resets earlier.
- Telemetry, Sentry reports and the run detail header still label runs with the
  agent's adapter; cancel, the run lists, the log viewer and the issue live view
  use the run's dispatched adapter.

## 10. Rollout

- Opt-in per agent, with no migration.
- Deploy to the fork's `deploy` branch first. Enable it on one agent and force a
  quota failure (for example with a test account) before enabling it widely.
- Propose upstream via #14721 after it runs in production.

## 11. Effort estimate

| Part | Estimate |
|---|---|
| Shared schema and route validation | 0.5 day |
| Activation, lane at claim, effective agent and guard | 1–1.5 days |
| Session gap fixes and switch-back fresh session | 0.5–1 day |
| Run adapter in APIs and UI parser | 0.5 day |
| UI config block and badge | 1 day |
| Tests (embedded-PG heartbeat suite, routes, UI) | 1–1.5 days |
| **Total** | **about 4.5–6 days** |
