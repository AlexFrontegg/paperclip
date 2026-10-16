# Fork changes

This fork (`AlexFrontegg/paperclip`, deploy branch `deploy`) adds the features below on top of `paperclipai/paperclip`. Use this list when merging an upstream release: every hook point must still exist after the merge, and every proving test must pass.

## Usage-limit fallback

When an agent's primary AI hits its usage limit, stops responding twice in a row, or its account is signed out, the agent runs on a second adapter and AI connection until the primary is back. Design: [plans/2026-10-06-usage-limit-fallback.md](plans/2026-10-06-usage-limit-fallback.md).

Core:
- `packages/shared/src/usage-limit-fallback.ts`: config, state and helpers. `validators/agent.ts` accepts `runtimeConfig.usageLimitFallback`.
- `server/src/services/usage-limit-fallback.ts`: activation, suspension, the effective agent for a run, and the adapter chosen at claim.

Hook points:
- `heartbeat.ts` `executeRun`: the run executes `effectiveAgentForRun(storedAgent, run)`; fallback runs drop the issue's engine overrides; a resume from a run on another adapter starts fresh; a deferred fallback retry is scheduled after cleanup.
- `heartbeat/retries.ts`: `scheduleBoundedRetryForRun` switches to the fallback on a quota or repeated outage failure; `handleUsageLimitFallbackAccountFailure`; `deferredUsageLimitFallbackRetries`.
- `heartbeat/queue.ts`: the claim stores `adapterDispatch` from `resolveAdapterDispatchForClaim`.
- `heartbeat/scheduling.ts`: a quota recovery monitor lets the other lane take the attempt.
- `heartbeat/run-completion.ts`: account failures go to the fallback handler; the primary's task session is cleared after a fallback turn.
- `heartbeat/run-control.ts`: release waits for a deferred fallback retry; Stop sends SIGINT by the claimed adapter.
- `heartbeat/run-state.ts`: `dispatchedAdapterType` in run lists; a session reset clears the fallback's sessions and keeps the fallback state.
- `heartbeat/session-preparation.ts`, `heartbeat/execution-configuration.ts`, `execution-workspace-policy.ts` (`withoutFallbackEngineOverrides`).
- `recovery/service.ts`: a quota wait can move the work to the fallback now.
- `lib/agent-records.ts` and `services/agent-hiring.ts`: a hire installs the fallback AI connection.
- `routes/agents.ts`, `services/agents.ts`, `services/activity.ts`, `services/connection-intents.ts`, `routes/openapi.ts`.
- UI: `UsageLimitFallbackField.tsx`, `AgentConfigForm.tsx` (`label` prop on the model and effort pickers), `lib/agent-config-patch.ts`, `pages/AgentDetail.tsx`, `api/agents.ts`.

Proving tests: `server/src/__tests__/heartbeat-usage-limit-fallback.test.ts`, `server/src/__tests__/agent-usage-limit-fallback-routes.test.ts`, `packages/shared/src/usage-limit-fallback.test.ts`, `ui/src/components/UsageLimitFallbackField.test.tsx`, `ui/src/lib/agent-config-patch.test.ts`.

## GitHub review bot

- **Own GitHub App sign-in:** `deploymentOAuthClient` in `packages/shared/src/types/app-definition.ts` and `app-definitions/github.json`. Test: `packages/shared/src/app-definitions.test.ts`.
- **Reviewed authors:** listed teammates without a Paperclip account get automatic reviews, and can mention or reply to the bot in pull request conversations. Their runs use only the bot's GitHub connection.
- **Resolve fixed findings:** the `resolve_finding` bot tool replies in and resolves the bot's own inline threads at the current head, behind the "Resolve fixed findings" setting.
- Hook points: `chat-github-review-policy.ts`, `chat-github-events.ts`, `chat-github-reviews.ts`, `chat-github-tools.ts`, `chat-github-management.ts`, `chat-github-response-comments.ts`, `github-operation-credentials.ts`, `chat-channels/github/*`, `chat-channels/inbound/*`, `chat-channels/provider-effects.ts`, `heartbeat/execution-configuration.ts` (bot-only GitHub), `native-runtime/chat-attachment-reuse.ts`, `packages/shared/src/{types,validators}/chat-github.ts`, UI `pages/apps/chat/GitHubBotConfiguration.tsx`.
- Proving tests: `server/src/__tests__/chat-channels.integration.test.ts`, `server/src/__tests__/heartbeat-reviewed-chat-binding.integration.test.ts`, `server/src/services/chat-github-review-policy.test.ts`, `packages/shared/src/validators/chat-github.test.ts`, `ui/src/pages/apps/chat/GitHubAccessEditor.test.tsx`.
- Docs: `doc/connections/GITHUB-REVIEW-BOT.md`, `maps/*/chat-channels.md`.

The upstream-layout versions of the three GitHub features are kept on branch `ports/github-bot` (upstream master plus the port commits). Take these files from that branch when an upstream merge conflicts in them.

## Remote MCP client credentials

A custom remote MCP connection can sign in with OAuth client credentials and renew its token with a refresh token fallback.
- Hook points: `packages/shared/src/validators/tool-access.ts`, `server/src/services/tool-access.ts`, `server/src/routes/tool-access.ts`, UI `features/connections/ConnectionSetupFlow.tsx` and `pages/apps/generic-mcp-connect.ts`.
- Proving tests: `server/src/__tests__/generic-mcp-connection.test.ts`, `server/src/__tests__/tool-access-service.test.ts`, `packages/shared/src/validators/tool-access.test.ts`, `ui/src/pages/apps/generic-mcp-connect.test.ts`, `ui/src/pages/apps/AppsConnect.test.tsx`.
- Docs: `doc/connections/GENERIC-REMOTE-MCP.md`.

## CI

- `.github/workflows/pr.yml` calls the fork's `pr-trusted.yml@deploy`; `commitperclip-review.yml` skips upstream-only bot steps. Keep upstream's job conditions and swap only the `uses:` line.
- `pnpm-lock.yaml`: take upstream's version, then run `pnpm install --lockfile-only` only if the fork added a dependency.

## Merging an upstream release

1. Branch from `deploy` and merge the upstream tag.
2. For the GitHub bot files, take `ports/github-bot`'s version (rebase that branch on the tag first).
3. For the fallback, keep upstream's code and re-apply the hook points above.
4. Type-check `server` and `ui`, and compare with upstream's own errors at the tag.
5. Run every proving test file above in full, not filtered by test name.
