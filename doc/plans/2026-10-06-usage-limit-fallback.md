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
- Saving a fallback on another adapter applies that adapter's create defaults to
  the fallback keys, so a Codex fallback for a Claude agent gets
  `dangerouslyBypassApprovalsAndSandbox` like a new Codex agent; the UI shows
  that setting explicitly. A fallback on the primary's adapter gets no defaults
  and never overrides the primary's sandbox and permission flags.
- A primary that keeps its permission checks (`dangerouslySkipPermissions: false`
  on Claude, `dangerouslyBypassApprovalsAndSandbox: false` on Codex) keeps them
  on a fallback on the other adapter unless the fallback sets its own value.
  This applies when saving and when building the run's config, and the UI shows
  the Claude and Codex permission toggles for a cross-adapter fallback.

Validation on create, hire and update (`routes/agents.ts:4636, 4885, 5562-5570`):

- The fallback adapter must be in the v1 allow-list and selectable
  (`assertSelectableAdapterType`).
- `isAiConnectionCompatible` and `validateManagedAgentBinding(...fallback.adapterType...)`
  must pass for the fallback binding whenever the fallback is enabled, including
  when a fallback saved as disabled is turned on. Create and hire install the
  fallback account for the new agent, like the primary account.
- A PATCH that omits `usageLimitFallback` preserves it, like `aiConnection`
  (`routes/agents.ts:5562`).
- When the primary uses a managed AI account, the fallback must name its own
  account. Otherwise a limit would bring back host or legacy credentials for a
  managed agent. Lane selection and activation apply the same rule to stored
  configs.
- Changing the fallback of an agent with external instructions needs an
  instance admin, like changing its adapter.

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

### 5.2a When the primary is down or signed out

With `switchWhenUnavailable` (on by default for a new fallback in the UI), two
more primary-lane failures activate the fallback, in either direction between
Claude Code and Codex. The state records the reason (`provider_outage` or
`primary_signed_out`), and the header and run events say why the agent switched.

- **Outage:** a second `transient_upstream` failure in a row on the primary.
  Each retry records the run it retries, that run's error family and its lane
  (`usageLimitPreviousFailure`), and only a direct retry of a primary-lane
  outage counts, so a copied older failure or a blip on the fallback never does.
  The first failure retries the primary as before, so one blip never switches. The window
  is 30 minutes, then the primary is tried again. A blip on the fallback lane
  gets the normal short retry.
- **Signed out:** an AI sign-in failure, or a managed account that cannot be
  prepared (`configuration_incomplete` with `ai_connection_unavailable`). The
  sign-in card is still raised for the primary, and the retry runs on the
  fallback at once.
  - If the primary's shared or delegated account is marked for sign-in, the
    state sets `waitForReconnect`. Each claim then checks that account: still
    signed out keeps the fallback and pushes `activeUntil` 30 minutes ahead;
    reconnected clears the state, so the next run uses the primary. A suspended
    fallback is not kept past its window.
  - Any other account uses a 30-minute window, so a fix is picked up without a
    loop of failed runs. That includes a host login, a managed account that
    still looks usable, and a personal (`responsible_user`) account, whose
    sign-in belongs to one user and must not hold the agent for everyone.
- Failures of the work itself (model refusal, tool errors, the turn cap) never
  activate the fallback.
- When two activations overlap, the one that lasts longer keeps its reason and
  switch-back rule. Turning the setting off ends an outage or sign-in switch at
  the next claim.

A `provider_quota` failure on the fallback lane never re-activates or extends the
fallback. Its retry waits until the earlier of the fallback's reset and the
current `activeUntil`, since the primary can take the work back then. If the
fallback was cleared meanwhile, the retry follows the normal backoff.

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

A fallback-lane run whose own AI account fails (an AI sign-in failure, or
`configuration_incomplete` with reason `ai_connection_unavailable`) suspends the
fallback for the rest of the window (`suspendedReason`). Other setup gaps, such
as a missing secret, are shared with the primary and go to recovery as usual.
Its retry is scheduled for `activeUntil`, the primary's reset, so the agent
waits as it would without a fallback instead of failing every run or
escalating to the board. A suspended state is not reactivated until it expires.

- This covers failures while preparing the fallback account (the setup path)
  and sign-in failures reported by the adapter.
- The broken fallback used the attempt, not the work, so the wait for the
  primary always gets one more retry, even when the bounded budget is spent.
- No sign-in card is raised on the task for a fallback account, because the card
  completes against the primary's account. The fallback account is marked
  unhealthy, the agent header shows the fallback as paused, and the account is
  repaired from the agent's settings.
- A personal (`responsible_user`) fallback account belongs to the run's user, so
  its failure does not suspend the fallback for the agent: only that run waits
  for the primary, the marked account sends that user's later runs to the
  primary at claim, and other users keep the fallback.
- Suspending sets only `suspendedReason` in one conditional update, so it never
  overwrites a later `activeUntil` and does nothing after **Return to primary**.

### 5.4 Execution

Right after `getAgent` in `executeRun` (`heartbeat.ts:20489`), build an
`effectiveAgentForRun(agent, run)` that overlays `adapterType`, `adapterConfig`
and `runtimeConfig.aiConnection` for fallback-lane runs. `executeRun` reads
`agent.*` about 50 times, so shadowing the variable is the single safe point.

An issue's assignee overrides of engine settings (model, effort, chrome, the
permission flags and the other fallback keys) were chosen for the primary's
adapter, so a fallback-lane run drops them and keeps its own. Workspace
overrides apply on both lanes.

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
- After a fallback turn that kept a conversation, the primary's task session
  for that task is cleared, so the primary resumes fresh with the handoff after
  the switch-back. A fallback run that never started one, for example because
  it hit its own limit or could not sign in, leaves the primary's session alone.
- A full session reset (no task) keeps the fallback state; **Return to primary**
  ends it.
- A new activation (not an extension) clears the fallback adapter's task
  sessions, so a later window never resumes a conversation that misses the
  primary's turns since. A user session reset for a task clears its sessions
  on the primary's and the fallback's adapter, and leaves other adapters alone.
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
  running on Codex until <time>" while active, or that the fallback cannot run
  and the agent is waiting for the primary while suspended, with a "Return to <primary>"
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
- Outage switching needs the CLI engine. The ACP engine, the default for both
  adapters, reports usage limits and sign-in failures but no transient upstream
  failures, so an ACP primary never switches on an outage. The UI says so.
- Only `codex_local` supports managed MCP gateways, so a Codex primary that falls
  back to Claude runs without its gateway tools for the window.
- The adapters' failure classifiers search the whole failed transcript, so a
  failed task whose tool output mentions a rate limit, a 503 or a usage limit can
  be read as an outage or a limit and switch the agent. This predates the
  fallback; the fallback makes it more visible.
- A suspended fallback stays off until `activeUntil` even after its account is
  repaired; **Return to <primary>** or the next window starts it again.
- A signed-out host login is retried every 30 minutes while runs keep coming, and
  each failed retry raises another sign-in card.
- While the agent is idle, the header keeps showing "until <primary> is
  reconnected" after a reconnect or after the setting is turned off; the next
  claim clears it.
- If an outage window outlasts a usage-limit window and the setting is then
  turned off, the next run tries the primary while it may still be out of quota,
  which costs one failed run before the fallback re-activates.
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
