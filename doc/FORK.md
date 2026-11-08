# Fork changes

This fork (`AlexFrontegg/paperclip`, deploy branch `deploy`) adds the features below on top of `paperclipai/paperclip`. Use this list when merging an upstream release: every hook point must still exist after the merge, and every proving test must pass.

## Usage-limit fallback

When an agent's primary AI hits its usage limit, stops responding twice in a row, or its account is signed out, the agent runs on a second adapter and AI connection until the primary is back. Design: [plans/2026-10-06-usage-limit-fallback.md](plans/2026-10-06-usage-limit-fallback.md).

Core:
- `packages/shared/src/usage-limit-fallback.ts`: config, state and helpers. `validators/agent.ts` accepts `runtimeConfig.usageLimitFallback`.
- `server/src/services/usage-limit-fallback.ts`: activation, suspension, the effective agent for a run, and the adapter chosen at claim.

Hook points:
- `heartbeat.ts` `executeRun`: the run executes `effectiveAgentForRun(storedAgent, run)`; fallback runs drop the issue's engine overrides; a resume from a run on another adapter starts fresh; a deferred fallback retry is scheduled after cleanup.
- `heartbeat/retries.ts`: `scheduleBoundedRetryForRun` switches to the fallback on a quota or repeated outage failure, and picks Codex's transient retry mode from the failed run's claimed adapter; `handleUsageLimitFallbackAccountFailure`; `deferredUsageLimitFallbackRetries`.
- `heartbeat/queue.ts`: the claim stores `adapterDispatch` from `resolveAdapterDispatchForClaim`.
- `heartbeat/scheduling.ts`: a quota recovery monitor lets the other lane take the attempt.
- `heartbeat/run-completion.ts`: account failures go to the fallback handler; a turn on either lane clears the other lane's task session (inside upstream's `persistSessionState`, so it also covers the case-handoff path).
- `heartbeat/run-control.ts`: release waits for a deferred fallback retry; Stop sends SIGINT by the claimed adapter.
- `heartbeat/run-state.ts`: `dispatchedAdapterType` in run lists; a session reset clears the fallback's sessions and keeps the fallback state.
- `heartbeat/session-preparation.ts`, `heartbeat/execution-configuration.ts`, `execution-workspace-policy.ts` (`withoutFallbackEngineOverrides`).
- `recovery/service.ts`: a quota wait can move the work to the fallback now (the quota-retry helper runs inside upstream's recovery transaction).
- `satisfied-connection-intents.ts` (`isAssigneeAiSignIn`, `pendingCardsCoveredByFallback`): while the next run uses the fallback (`nextRunUsesFallback`), the primary's AI sign-in card does not hold the task. Callers: the retry gate and queued-run check in `connectionContinuationPendingResponse` and `modules/run-dispatch/adapters/postgres.ts`; the legacy follow-up in `recovery/disposition-repair.ts` (`collectDispositionRepairSourceState` and `readDispositionRepairDurableWaitingState`); the native follow-up in `heartbeat/run-lifecycle.ts` (`handleSuccessfulRunHandoff`).
- `lib/agent-records.ts` and `services/agent-hiring.ts`: a hire installs the fallback AI connection.
- `routes/agents.ts`, `services/agents.ts`, `services/activity.ts`, `services/connection-intents.ts`, `routes/openapi.ts`.
- UI: `UsageLimitFallbackField.tsx`, `AgentConfigForm.tsx` (`label` prop on the model and effort pickers), `lib/agent-config-patch.ts`, `pages/AgentDetail.tsx`, `components/run-log/LogViewer.tsx` (`run.dispatchedAdapterType ?? adapterType`), `api/agents.ts`.

Proving tests: `server/src/__tests__/heartbeat-usage-limit-fallback.test.ts`, `server/src/__tests__/agent-usage-limit-fallback-routes.test.ts`, `server/src/__tests__/satisfied-connection-intents.test.ts`, `packages/shared/src/usage-limit-fallback.test.ts`, `ui/src/components/UsageLimitFallbackField.test.tsx`, `ui/src/lib/agent-config-patch.test.ts`.

**AI account health:** every board page warns when a shared AI account needs sign-in or an agent runs on its fallback or has no working AI. When every account works, the bar turns amber and names the agents still on their fallback. The agent page's fallback box follows this health once it loads, so a saved fallback that the next run ends is not shown.
- Hook points: `server/src/services/ai-health.ts`, `GET /companies/:companyId/ai-health` in `routes/ai-connections.ts`, `routes/openapi.ts`; UI `components/AiAccountHealth.tsx`, `hooks/useCompanyAiHealth.ts`, `lib/ai-health.ts`, `Layout.tsx`, `BreadcrumbBar.tsx`, `SidebarAgents.tsx`, `pages/Agents.tsx`, `pages/AgentDetail.tsx` (and their `.production.tsx` copies).
- Proving tests: `server/src/__tests__/ai-health-routes.test.ts`, `ui/src/components/AiAccountHealth.test.tsx`, `ui/src/components/SidebarAgents.test.tsx`, `ui/src/components/Layout.test.tsx`, `ui/src/components/BreadcrumbBar.test.tsx`.

**Codex out of credits:** a Codex workspace that is out of credits counts as a provider quota failure, so the fallback takes over. Only Codex's own error reports count (`error` and `turn.failed` events, plain CLI lines), never tool output or agent text in item events, so a crash on a repo that mentions "usage limit" does not start the fallback (`codexErrorReportLines`). Hook points: the quota patterns and `isCodexProviderQuotaError` in `packages/adapters/codex-local/src/server/parse.ts`, and `acp.ts`. Proving tests: `packages/adapters/codex-local/src/server/parse.test.ts`, `acp.quota.test.ts`.

**Paperclip Runner agents:** a Runner agent that runs Claude Code or Codex can have a fallback, which runs on the Claude Code or Codex adapter directly. Detection is upstream's (`e37ab23dbc`, below): the Runner ends a turn on the account's limit with `native_provider_usage_limit`, for Codex's `usageLimitExceeded` and for a Claude limit whose title the Runner types as `quota_exhausted` or `rate_limit`. Turn, budget and context limits stay `native_provider_terminal_failed`.
- The fallback takes over a `native_provider_usage_limit` turn unless its `providerFailure` is a `rate_limit`, which clears within minutes. The executor then neither blocks the task nor opens its board card, and marks the failed run `resultJson.usageLimitFallbackHandoff`. Rate limits, turn and budget limits, remote Runner targets, ambiguous provider state, unverified runner ownership, and agents without a usable fallback still block the task as upstream does.
- The run's failure handler switches only on that mark, so it decides on the executor's evidence and never on the first attempt's `providerFailure`, which the run keeps. The fallback lasts until the reset upstream's hold reads (`agentProviderLimitCooldown`: the provider's clock read at the failed run's finish time, at most 24 hours, so a weekly limit tries the primary once a day), and its first turn has a retry attempt of its own. If no retry can be scheduled after all, releasing the run finds no successor, and upstream's release blocks the task with a board card (`recordNativeTerminalRecoveryIfNeeded`), so the task never stays in progress with no run.
- The safe-replacement sweeper never selects these runs (`nativeReplacementPending` leaves out `native_provider_usage_limit`), so no replacement marker is needed.
- Upstream's provider-limit hold (`heartbeat/provider-limit-wait.ts`) never holds a fallback-lane run of any agent: the claim has chosen the lane before the hold runs. Its evidence leaves out fallback-lane runs, so the fallback account's limit does not hold the primary, and a fallback success does not end the primary's limit. Primary-lane runs keep upstream's hold, for example while the fallback is suspended.
- The fork also reads a reset on a named day (`parseProviderQuotaClockReset`): Claude's weekly and two-day titles, "resets Nov 12 at 6:49am (UTC)", and Codex's "try again at Nov 9th, 2026 4:30 PM". The hold and the fallback therefore agree on it. Upstream reads only a clock and waits one hour without it.
- Hook points: the failure handler in `native-runtime/native-session-executor.ts` (`handedToUsageLimitFallback` skips the block and the card and writes the mark); `usage-limit-fallback.ts` (`isRunnerUsageLimit`, `usageLimitFallbackCanTakeOverRunnerTurn`, `RUNNER_USAGE_LIMIT_HANDOFF_KEY`, `runnerTurnHandedToFallback`, and `checkUsageLimitFallbackActivation`, which `activateUsageLimitFallback` shares); `heartbeat/retries.ts` (`switchToFallbackForRunnerUsageLimit`, called from `handleUsageLimitFallbackAccountFailure`, and `oneMoreRetryAttempt`); `heartbeat.ts` (the fallback-lane exemption at the `deferRunForProviderLimit` call); `agentProviderLimitCooldown` in `native-runtime/native-startup-retry.ts` (the fallback-lane filter); `provider-quota-reset.ts` (named days); `usageLimitFallbackConfigProblem` in `packages/shared/src/usage-limit-fallback.ts` (reads the Runner's agent with `agentHarnessType`); `ai-health.ts` (selects `provider` and `acpxAgent`); UI `UsageLimitFallbackField.tsx`.
- Proving tests: `server/src/services/native-runtime/native-usage-limit-fallback.integration.test.ts` (the Runner's real terminals for Codex and for Claude Code 2.1.286's titles; it covers the hand-off, the rate, turn and budget limits that still block, and the release with and without a fallback retry); the "a Paperclip Runner turn that stopped on a usage limit" tests in `server/src/services/heartbeat/retries.test.ts`; "runs the fallback while the primary's provider limit holds only the primary's work" in `server/src/__tests__/heartbeat-usage-limit-fallback.test.ts`; `server/src/services/provider-quota-reset.test.ts`; upstream's `server/src/__tests__/heartbeat-provider-limit-wait.test.ts`; the Runner cases in `packages/shared/src/usage-limit-fallback.test.ts` and `ui/src/components/UsageLimitFallbackField.test.tsx`.

## GitHub review bot

- **Own GitHub App sign-in:** `deploymentOAuthClient` in `packages/shared/src/types/app-definition.ts` and `app-definitions/github.json`, which offers only personal accounts for this method. Test: `packages/shared/src/app-definitions.test.ts`.
- **Reviewed authors:** listed teammates without a Paperclip account get automatic reviews, and can mention or reply to the bot in pull request conversations. Their runs use only the bot's GitHub connection.
- **Read-only bot token for `gh`:** bot-only runs without a dedicated agent account get a short-lived installation token from the bot's GitHub App with read permissions only (`githubBotReadOnlyToken` in `chat-github-client.ts`, used by `github-operation-credentials.ts`; run source `bot`). A refused token exports nothing. The bot-scope check finds the run's issue with upstream's `boundRunIssueId(run)`, so a run bound only by `heartbeat_runs.issue_id` is limited to the bot too.
- **Read-only GitHub for this agent:** the bot setting `agentReadOnlyGitHub` gives every run of the bot's agent only the bot's read-only token for git and `gh` (`githubReadOnlyAgentBotConnection` in `chat-github-tools.ts`, `resolveRunGitHubIdentitySelection` in `github-operation-credentials.ts`, called from `heartbeat/execution-configuration.ts`).
- **Resolve fixed findings:** the `resolve_finding` bot tool replies in and resolves the bot's own inline threads at the current head, behind the "Resolve fixed findings" setting. `GITHUB_PUBLICATION_TOOL_NAMES` in `chat-github-reviews.ts` lists the tools whose retries report the saved receipt; `tool-gateway.ts` uses it too, and upstream's recovery fence for operations with an unknown outcome exempts `resolve_finding` like the other publication tools.
- Hook points: `chat-github-review-policy.ts`, `chat-github-events.ts`, `chat-github-reviews.ts`, `chat-github-tools.ts`, `chat-github-management.ts`, `chat-github-response-comments.ts`, `chat-github-client.ts`, `github-operation-credentials.ts`, `chat-channels/github/*`, `chat-channels/inbound/*`, `chat-channels/provider-effects.ts`, `heartbeat/execution-configuration.ts` (bot-only GitHub), `native-runtime/chat-attachment-reuse.ts`, `packages/shared/src/{types,validators}/chat-github.ts`, UI `pages/apps/chat/GitHubBotConfiguration.tsx`.
- Proving tests: `server/src/__tests__/chat-channels.integration.test.ts`, `server/src/__tests__/heartbeat-reviewed-chat-binding.integration.test.ts`, `server/src/services/chat-github-review-policy.test.ts`, `packages/shared/src/validators/chat-github.test.ts`, `ui/src/pages/apps/chat/GitHubAccessEditor.test.tsx`.
- Docs: `doc/connections/GITHUB-REVIEW-BOT.md`, `maps/*/chat-channels.md`.

Branch `ports/github-bot` holds the first upstream-layout ports of the four GitHub features. It predates later fork changes (#17, #22, #31), so `deploy`'s versions are the fork's truth; use the branch only as a reference.

## Chat messages wake blocked tasks

A message in a connected chat conversation (Slack and the other chat providers) wakes a task that is blocked or paused, as a comment does. Upstream issues #15040 and #15974. A paused tree admits only a message that a linked person wrote; a guest's message, a bot's message and an automatic GitHub event stay held (`isPersonChatMessage`).
- Hook points: `EXTERNAL_CHAT_MESSAGE_WAKE_REASON` in `packages/shared/src/types/chat-channels.ts`, used by `server/src/services/chat-channels/inbound/wakeups.ts` and listed in the interaction wake reasons of `server/src/services/issue-tree-control.ts`, which also matches the chat wake's `wakeCommentId`.
- Proving test: `server/src/__tests__/heartbeat-dependency-scheduling.test.ts`.

## Linear-time scan of long base64 blobs

Long base64 blobs in run logs no longer make the secret patterns scan in quadratic time and freeze the server: the name patterns start with a lookbehind instead of `\b`. Only that case is fixed: redacting many quoted `authorization:` values is still quadratic in upstream's code (64 KB takes about 1 s).
- Hook points: `packages/adapter-utils/src/command-redaction.ts`, `server/src/redaction.ts`.
- Proving tests: `packages/adapter-utils/src/command-redaction.test.ts`, `server/src/__tests__/redaction.test.ts`, `server/src/__tests__/heartbeat-run-log.test.ts`.

## Remote MCP client credentials

A custom remote MCP connection can sign in with OAuth client credentials and renew its token with a refresh token fallback.
- Hook points: `packages/shared/src/validators/tool-access.ts`; upstream split `server/src/services/tool-access.ts` into `server/src/services/tool-access/**`: `oauth/client.ts` (`renewOAuthToken`), `oauth/metadata.ts` (`usesOAuthClientCredentials`), `oauth/connection-refresh.ts`, `oauth/grant-refresh.ts`, `oauth/credential-store.ts`, `oauth/client-settings.ts` (`appWithDeploymentOAuthClient`, built on upstream's `oauthClientConfig`), `catalog/discovery.ts` (`oauth_client_credentials_rejected`), `catalog/failures.ts`; `server/src/routes/tool-access.ts`; UI `features/connections/ConnectionSetupFlow.tsx` and `pages/apps/generic-mcp-connect.ts`.
- Proving tests: `server/src/__tests__/generic-mcp-connection.test.ts`, `server/src/__tests__/tool-access-service.test.ts`, `packages/shared/src/validators/tool-access.test.ts`, `ui/src/pages/apps/generic-mcp-connect.test.ts`, `ui/src/pages/apps/AppsConnect.test.tsx`.
- Docs: `doc/connections/GENERIC-REMOTE-MCP.md`.

## Upstream fixes taken early

- `e37ab23dbc` (#19246), "hold an agent's new work while its provider usage limit is active", cherry-picked onto the 2026-11 sync. It arrives with the next upstream release. The Runner types a Claude account limit, the server ends such a turn with `native_provider_usage_limit`, and `heartbeat/provider-limit-wait.ts` holds the agent's new work until the reset. The Runner usage-limit fallback builds on it (see "Paperclip Runner agents" above). At that release, take upstream's version of the commit's files and keep the fork's three changes to them: named days in `provider-quota-reset.ts`, the fallback-lane filter in `agentProviderLimitCooldown`, and the fallback-lane exemption at the `deferRunForProviderLimit` call in `heartbeat.ts`. Proving tests: upstream's `server/src/__tests__/heartbeat-provider-limit-wait.test.ts` and `native-startup-retry.integration.test.ts`, with the fork's tests listed above.
- The 2026-11 sync took upstream's Codex shell environment (#17216), which now passes `PAPERCLIP_GITHUB_BROKER_TOKEN` and `PAPERCLIP_GITHUB_BRIDGE_TOKEN` itself, so the fork's carry was dropped. Proving test kept: `packages/adapter-utils/src/codex-shell-environment.test.ts`.

## Building the labs image

- The `Dockerfile` keeps upstream's floating `node:24-trixie-slim` base. Run `docker pull node:24-trixie-slim`, build with `docker build --pull ...`, then check `node --version` inside the image. A cached base kept labs on Node 24.21.0 until 2026-10-25, after its security release. `--pull` on one build does not refresh the local tag for the next build.

## CI

- `.github/workflows/pr.yml` calls the fork's `pr-trusted.yml@deploy`; `commitperclip-review.yml` skips upstream-only bot steps. Keep upstream's job conditions and swap only the `uses:` line.
- `pnpm-lock.yaml`: take upstream's version, then run `pnpm install --lockfile-only` only if the fork added a dependency.

## Merging an upstream release

1. Branch from `deploy` and merge the upstream tag.
2. For the GitHub bot files, combine upstream's changes with `deploy`'s fork versions (`ports/github-bot` is only a reference).
3. For the fallback, keep upstream's code and re-apply the hook points above.
4. Type-check `server` and `ui`, and compare with upstream's own errors at the tag. The server type check skips `src/__tests__`, so a broken test merge shows up only when the test runs.
5. Run every proving test file above in full, not filtered by test name.
6. Right after the deploy, turn on **Settings → Experimental → GitHub review bots** (`enableGitHubReviewBots`, off by default since v2026.1023.0). Until then the bot keeps reviewing, but its settings page redirects away and GitHub identity linking returns 403, so new members' pull requests are not reviewed.
