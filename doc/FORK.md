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
- `heartbeat/run-completion.ts`: account failures go to the fallback handler; a turn on either lane clears the other lane's task session.
- `heartbeat/run-control.ts`: release waits for a deferred fallback retry; Stop sends SIGINT by the claimed adapter.
- `heartbeat/run-state.ts`: `dispatchedAdapterType` in run lists; a session reset clears the fallback's sessions and keeps the fallback state.
- `heartbeat/session-preparation.ts`, `heartbeat/execution-configuration.ts`, `execution-workspace-policy.ts` (`withoutFallbackEngineOverrides`).
- `recovery/service.ts`: a quota wait can move the work to the fallback now.
- `lib/agent-records.ts` and `services/agent-hiring.ts`: a hire installs the fallback AI connection.
- `routes/agents.ts`, `services/agents.ts`, `services/activity.ts`, `services/connection-intents.ts`, `routes/openapi.ts`.
- UI: `UsageLimitFallbackField.tsx`, `AgentConfigForm.tsx` (`label` prop on the model and effort pickers), `lib/agent-config-patch.ts`, `pages/AgentDetail.tsx`, `api/agents.ts`.

Proving tests: `server/src/__tests__/heartbeat-usage-limit-fallback.test.ts`, `server/src/__tests__/agent-usage-limit-fallback-routes.test.ts`, `packages/shared/src/usage-limit-fallback.test.ts`, `ui/src/components/UsageLimitFallbackField.test.tsx`, `ui/src/lib/agent-config-patch.test.ts`.

**AI account health:** every board page warns when a shared AI account needs sign-in or an agent runs on its fallback or has no working AI.
- Hook points: `server/src/services/ai-health.ts`, `GET /companies/:companyId/ai-health` in `routes/ai-connections.ts`, `routes/openapi.ts`; UI `components/AiAccountHealth.tsx`, `hooks/useCompanyAiHealth.ts`, `lib/ai-health.ts`, `Layout.tsx`, `BreadcrumbBar.tsx`, `SidebarAgents.tsx`, `pages/Agents.tsx`, `pages/AgentDetail.tsx` (and their `.production.tsx` copies).
- Proving tests: `server/src/__tests__/ai-health-routes.test.ts`, `ui/src/components/AiAccountHealth.test.tsx`, `ui/src/components/SidebarAgents.test.tsx`, `ui/src/components/Layout.test.tsx`, `ui/src/components/BreadcrumbBar.test.tsx`.

**Codex out of credits:** a Codex workspace that is out of credits counts as a provider quota failure, so the fallback takes over. Only Codex's own error reports count (`error` and `turn.failed` events, plain CLI lines), never tool output or agent text in item events, so a crash on a repo that mentions "usage limit" does not start the fallback (`codexErrorReportLines`). Hook points: the quota patterns and `isCodexProviderQuotaError` in `packages/adapters/codex-local/src/server/parse.ts`, and `acp.ts`. Proving tests: `packages/adapters/codex-local/src/server/parse.test.ts`, `acp.quota.test.ts`.

## GitHub review bot

- **Own GitHub App sign-in:** `deploymentOAuthClient` in `packages/shared/src/types/app-definition.ts` and `app-definitions/github.json`, which offers only personal accounts for this method. Test: `packages/shared/src/app-definitions.test.ts`.
- **Reviewed authors:** listed teammates without a Paperclip account get automatic reviews, and can mention or reply to the bot in pull request conversations. Their runs use only the bot's GitHub connection.
- **Read-only bot token for `gh`:** bot-only runs without a dedicated agent account get a short-lived installation token from the bot's GitHub App with read permissions only (`githubBotReadOnlyToken` in `chat-github-client.ts`, used by `github-operation-credentials.ts`; run source `bot`). A refused token exports nothing.
- **Read-only GitHub for this agent:** the bot setting `agentReadOnlyGitHub` gives every run of the bot's agent only the bot's read-only token for git and `gh` (`githubReadOnlyAgentBotConnection` in `chat-github-tools.ts`, `resolveRunGitHubIdentitySelection` in `github-operation-credentials.ts`, called from `heartbeat/execution-configuration.ts`).
- **Resolve fixed findings:** the `resolve_finding` bot tool replies in and resolves the bot's own inline threads at the current head, behind the "Resolve fixed findings" setting. `GITHUB_PUBLICATION_TOOL_NAMES` in `chat-github-reviews.ts` lists the tools whose retries report the saved receipt; `tool-gateway.ts` uses it too.
- Hook points: `chat-github-review-policy.ts`, `chat-github-events.ts`, `chat-github-reviews.ts`, `chat-github-tools.ts`, `chat-github-management.ts`, `chat-github-response-comments.ts`, `chat-github-client.ts`, `github-operation-credentials.ts`, `chat-channels/github/*`, `chat-channels/inbound/*`, `chat-channels/provider-effects.ts`, `heartbeat/execution-configuration.ts` (bot-only GitHub), `native-runtime/chat-attachment-reuse.ts`, `packages/shared/src/{types,validators}/chat-github.ts`, UI `pages/apps/chat/GitHubBotConfiguration.tsx`.
- Proving tests: `server/src/__tests__/chat-channels.integration.test.ts`, `server/src/__tests__/heartbeat-reviewed-chat-binding.integration.test.ts`, `server/src/services/chat-github-review-policy.test.ts`, `packages/shared/src/validators/chat-github.test.ts`, `ui/src/pages/apps/chat/GitHubAccessEditor.test.tsx`.
- Docs: `doc/connections/GITHUB-REVIEW-BOT.md`, `maps/*/chat-channels.md`.

The upstream-layout versions of the four GitHub features are kept on branch `ports/github-bot` (upstream master plus the port commits). Take these files from that branch when an upstream merge conflicts in them.

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
- Hook points: `packages/shared/src/validators/tool-access.ts`, `server/src/services/tool-access.ts`, `server/src/routes/tool-access.ts`, UI `features/connections/ConnectionSetupFlow.tsx` and `pages/apps/generic-mcp-connect.ts`.
- Proving tests: `server/src/__tests__/generic-mcp-connection.test.ts`, `server/src/__tests__/tool-access-service.test.ts`, `packages/shared/src/validators/tool-access.test.ts`, `ui/src/pages/apps/generic-mcp-connect.test.ts`, `ui/src/pages/apps/AppsConnect.test.tsx`.
- Docs: `doc/connections/GENERIC-REMOTE-MCP.md`.

## Upstream fixes taken early

- Upstream #17216 (`042051904`): Codex shell commands see the secrets assigned to the agent, such as `GITHUB_TOKEN`. Our version leaves out upstream's telemetry keys (#16874, not merged yet). On the next sync, take upstream's version of these files.
- Fork change on top of it: `codexShellEnvironmentKeys` also passes the run's `PAPERCLIP_GITHUB_BROKER_TOKEN` (and `PAPERCLIP_GITHUB_BRIDGE_TOKEN`) when Paperclip set it. Upstream keeps every `PAPERCLIP_GITHUB_*` name out of Codex shells, so Paperclip's `gh`/`git` launchers report `capability_missing` and managed GitHub (the read-only review bot token) fails on Codex. Keep this on the next sync until upstream passes the capability another way. Proving test: `packages/adapter-utils/src/codex-shell-environment.test.ts`.

## CI

- `.github/workflows/pr.yml` calls the fork's `pr-trusted.yml@deploy`; `commitperclip-review.yml` skips upstream-only bot steps. Keep upstream's job conditions and swap only the `uses:` line.
- `pnpm-lock.yaml`: take upstream's version, then run `pnpm install --lockfile-only` only if the fork added a dependency.

## Merging an upstream release

1. Branch from `deploy` and merge the upstream tag.
2. For the GitHub bot files, take `ports/github-bot`'s version (rebase that branch on the tag first).
3. For the fallback, keep upstream's code and re-apply the hook points above.
4. Type-check `server` and `ui`, and compare with upstream's own errors at the tag. The server type check skips `src/__tests__`, so a broken test merge shows up only when the test runs.
5. Run every proving test file above in full, not filtered by test name.
6. Right after the deploy, turn on **Settings → Experimental → GitHub review bots** (`enableGitHubReviewBots`, off by default since v2026.1023.0). Until then the bot keeps reviewing, but its settings page redirects away and GitHub identity linking returns 403, so new members' pull requests are not reviewed.
