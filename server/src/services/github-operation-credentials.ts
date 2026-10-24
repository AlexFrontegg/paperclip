import { and, eq } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import {
  agents,
  heartbeatRuns,
  issues,
  projects,
  runIdentityContexts,
  type Db,
} from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { captureRunIdentity } from "./run-identity.js";
import {
  buildGitAuthInvocation,
  resolveManagedGitHubCredential,
  resolveManagedGitHubIdentitySelection,
} from "./git-credentials.js";
import { secretService } from "./secrets.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { isLowTrustQuarantined } from "./source-trust.js";
import {
  githubGuestBotConnectionForSession,
  githubReadOnlyAgentBotConnection,
} from "./chat-github-tools.js";
import { githubBotReadOnlyToken } from "./chat-github-client.js";

export type GitHubCredentialSummary = {
  status: "available" | "absent" | "unavailable";
  source?: "personal" | "dedicated" | "bot";
  login?: string;
  reason?: string;
  connectionId?: string;
  grantId?: string;
  authenticationMode?: "managed" | "host" | "anonymous";
};

/** A raw GitHub token cannot enforce the low-trust read-only tool boundary. */
async function allowsGitHubCredentialExport(
  db: Db,
  run: typeof heartbeatRuns.$inferSelect,
) {
  const issueId =
    run.contextSnapshot?.issueId ??
    run.contextSnapshot?.taskId ??
    run.nativeIssueId;
  if (
    issueId !== undefined &&
    issueId !== null &&
    (typeof issueId !== "string" || !isUuidLike(issueId))
  )
    return false;
  const [agent] = await db
    .select({ companyId: agents.companyId, permissions: agents.permissions })
    .from(agents)
    .where(
      and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)),
    );
  if (!agent) return false;
  const [issue] =
    typeof issueId === "string"
      ? await db
          .select({
            companyId: issues.companyId,
            projectId: issues.projectId,
            executionPolicy: issues.executionPolicy,
            sourceTrust: issues.sourceTrust,
          })
          .from(issues)
          .where(
            and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
          )
      : [];
  if (issueId !== undefined && issueId !== null && !issue) return false;
  if (isLowTrustQuarantined(issue?.sourceTrust)) return false;
  const projectId = issue?.projectId ?? run.contextSnapshot?.projectId;
  if (
    projectId !== undefined &&
    projectId !== null &&
    (typeof projectId !== "string" || !isUuidLike(projectId))
  )
    return false;
  const [project] =
    typeof projectId === "string"
      ? await db
          .select({
            companyId: projects.companyId,
            executionWorkspacePolicy: projects.executionWorkspacePolicy,
          })
          .from(projects)
          .where(
            and(
              eq(projects.id, projectId),
              eq(projects.companyId, run.companyId),
            ),
          )
      : [];
  if (projectId !== undefined && projectId !== null && !project) return false;
  return (
    resolveCoreTrustPreset({
      companyId: run.companyId,
      agent,
      project,
      issue,
      run: {
        companyId: run.companyId,
        executionPolicy: run.contextSnapshot?.executionPolicy,
      },
    }).kind === "standard"
  );
}

/** A bot-scoped run brokers the bot's read-only token, so launchers and native sessions treat it as a managed identity. */
export async function resolveRunGitHubIdentitySelection(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
    issueId: string | null;
    responsibleUserId: string | null;
  },
) {
  // A run started for a guest or reviewed author, or any run of an agent whose bot
  // turns on read-only GitHub, never receives a person's or the host's GitHub access.
  const botScoped = Boolean(
    (await githubReadOnlyAgentBotConnection(db, input)) ??
      (await githubGuestBotConnectionForSession(db, input)),
  );
  const selection = await resolveManagedGitHubIdentitySelection(db, input.companyId, {
    agentId: input.agentId,
    responsibleUserId: botScoped ? null : input.responsibleUserId,
    allowStandingDelegation: false,
  });
  return botScoped ? { ...selection, configured: true } : selection;
}

/** No company secrets or ambient credentials are consulted by this path. */
export async function resolveGitHubOperationCredentials(
  db: Db,
  input: {
    companyId: string;
    agentId: string;
    runId: string;
  },
  fetchImpl: typeof fetch = fetch,
) {
  const { run, context } = await captureRunIdentity(db, input);
  if (!context) throw forbidden("This run predates managed GitHub credentials");
  let summary: GitHubCredentialSummary;
  let env: Record<string, string> = {};
  // A sponsored guest's responsible person is an internal accountability field,
  // not authorization to export that person's (or a dedicated bot's) token.
  // Re-read every policy source for each operation, including a run's retained
  // boundary after task policy edits. Deny before touching the credential store.
  if (!(await allowsGitHubCredentialExport(db, run))) {
    summary = {
      status: "unavailable",
      reason:
        "GitHub credentials are not available to low-trust or unverified executions; use authorized read-only tools.",
    };
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
    return {
      identityContextId: context.id,
      revision: context.revision,
      ...summary,
      env,
    };
  }
  try {
    // Read the task the same way as the export check, so no run escapes the bot scope.
    const runIssueId = run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId ?? run.nativeIssueId;
    const issueId = typeof runIssueId === "string" ? runIssueId : null;
    // The bot's switch outranks the agent's own account, which may be able to write.
    const readOnlyConnectionId = await githubReadOnlyAgentBotConnection(db, input);
    // A run started for a guest or reviewed author may use only the agent's own account,
    // otherwise the bot App's read-only token.
    const botConnectionId = readOnlyConnectionId
      ?? await githubGuestBotConnectionForSession(db, { ...input, issueId });
    const botScoped = Boolean(botConnectionId);
    const resolved = readOnlyConnectionId
      ? null
      : await resolveManagedGitHubCredential(
          db,
          secretService(db),
          input.companyId,
          {
            agentId: input.agentId,
            heartbeatRunId: input.runId,
            allowStandingDelegation: false,
            responsibleUserId:
              botScoped || context?.cause === "company_default"
                ? null
                : (context?.responsibleUserId ?? null),
            issueId,
          },
        );
    if (resolved?.credential) {
      summary = {
        status: "available",
        source: resolved.credential.identitySource,
        login: resolved.credential.githubIdentity?.login,
        connectionId: resolved.credential.connectionId,
        grantId: resolved.credential.grantId,
        authenticationMode: "managed",
      };
      env = buildGitAuthInvocation(resolved.credential).env;
    } else if (botConnectionId) {
      const token = await githubBotReadOnlyToken(db, input.companyId, botConnectionId, input.agentId, fetchImpl);
      summary = {
        status: "available",
        source: "bot",
        connectionId: botConnectionId,
        authenticationMode: "managed",
      };
      env = buildGitAuthInvocation({ token, source: "managed_connection", secretName: null }).env;
    } else {
      summary = {
        status: resolved?.configured ? "unavailable" : "absent",
        source: resolved?.identitySource ?? "personal",
        reason: resolved?.error ?? "No GitHub identity connected",
      };
    }
  } catch {
    // Provider/secret errors can contain sensitive response bodies. Never persist them.
    summary = {
      status: "unavailable",
      reason: "GitHub credentials are temporarily unavailable",
    };
  }
  if (context)
    await db
      .update(runIdentityContexts)
      .set({ github: summary })
      .where(eq(runIdentityContexts.id, context.id));
  return {
    identityContextId: context?.id ?? null,
    revision: context?.revision ?? null,
    ...summary,
    env,
  };
}
