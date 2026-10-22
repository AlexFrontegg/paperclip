import { randomUUID } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  chatConversations,
  chatDeliveries,
  chatEndpoints,
  chatExternalPrincipals,
  chatGitHubConfigurations,
  chatMessageLinks,
  chatPublications,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
  toolApplications,
  toolConnections,
} from "@paperclipai/db";
import { defaultGitHubReviewPolicy } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import {
  enqueueChatRunMilestones,
  resolveChatRunPresentationAuthorizationReason,
} from "../services/chat-run-publications.js";

describe("GitHub bot automatic run publications", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const companyId = randomUUID(),
    agentId = randomUUID(),
    issueId = randomUUID(),
    endpointId = randomUUID(),
    conversationId = randomUUID(),
    principalId = randomUUID(),
    commentId = randomUUID(),
    deliveryId = randomUUID();
  const ownerUserId = "github-responsible-user";
  const reviewConfiguration = {
    version: 1 as const,
    toolsEnabled: true,
    responsibleUserId: ownerUserId,
    memberAccess: "all_linked" as const,
    people: [],
    defaults: defaultGitHubReviewPolicy(),
    repositories: {},
    reviewedAuthors: [{ githubUserId: "91", login: "teammate" }],
  };

  async function insertRun(status: "running" | "succeeded" | "failed") {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status,
      invocationSource: "assignment",
      triggerDetail: "system",
      contextSnapshot: {
        issueId,
        source: "chat:github",
        wakeReason: "External chat message received",
        wakeCommentIds: [commentId],
        commentId,
      },
      resultJson:
        status === "succeeded"
          ? { presentationDecision: { authorizationReason: "internal_agent_write" } }
          : null,
    });
    return runId;
  }

  function runPublications(runId: string) {
    return db
      .select({ payload: chatPublications.payload })
      .from(chatPublications)
      .where(like(chatPublications.idempotencyKey, `run:${runId}:%`));
  }

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("github-run-publications-");
    db = createDb(temporary.connectionString);
    await db.insert(companies).values({ id: companyId, name: "GitHub publications", issuePrefix: "GHP", issueCounter: 1 });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Review bot", adapterType: "paperclip_runner",
      adapterConfig: { provider: "codex" }, status: "active",
    });
    await db.insert(issues).values({
      id: issueId, companyId, title: "PR #91 review", issueNumber: 1, identifier: "GHP-1",
      status: "in_review", workMode: "standard", assigneeAgentId: agentId,
    });
    const applicationId = randomUUID(),
      connectionId = randomUUID();
    await db.insert(toolApplications).values({
      id: applicationId, companyId, applicationKey: `chat:github:${endpointId}`, name: "GitHub", type: "chat", status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: "GitHub", uid: `chat-github-${endpointId}`,
      connectionPurpose: "channel", transport: "chat_sdk", status: "active", enabled: true,
    });
    await db.insert(chatEndpoints).values({
      id: endpointId, companyId, connectionId, provider: "github", publicId: randomUUID(), assignedAgentId: agentId,
      status: "active", providerAccountId: "github-app", allowUnlinkedPeople: false,
    });
    await db.insert(chatConversations).values({
      id: conversationId, companyId, endpointId, issueId, externalConversationId: "paperclipai/paperclip",
      externalThreadId: "github:paperclipai/paperclip:91", externalLabel: "PR #91", state: "active",
    });
    await db.insert(chatExternalPrincipals).values({
      id: principalId, companyId, provider: "github", providerAccountId: "github-app", externalId: "91", kind: "user",
    });
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: ownerUserId, status: "active", membershipRole: "member",
    });
    await db.insert(chatGitHubConfigurations).values({
      endpointId, companyId, updatedByUserId: ownerUserId, configuration: reviewConfiguration,
    });
    await db.insert(issueComments).values({
      id: commentId, companyId, issueId, authorType: "user", authorUserId: ownerUserId,
      body: "Fixed in the latest commit.",
    });
    await db.insert(chatDeliveries).values({
      id: deliveryId, companyId, endpointId, conversationId, principalId, providerEventId: "github-reply",
      deduplicationKey: "github-reply", eventKind: "message", normalizedEvent: {}, state: "processed", attempts: 1,
      processedAt: new Date(),
    });
    await db.insert(chatMessageLinks).values({
      companyId, endpointId, conversationId, deliveryId, commentId, providerMessageId: "github-reply", direction: "inbound",
    });
  }, 30_000);
  afterAll(async () => {
    await temporary?.cleanup();
  });

  it("posts no working or completion notice for a configured bot but keeps the failure notice", async () => {
    const runningRunId = await insertRun("running");
    const succeededRunId = await insertRun("succeeded");
    const failedRunId = await insertRun("failed");

    await enqueueChatRunMilestones(db);

    await expect(runPublications(runningRunId)).resolves.toHaveLength(0);
    await expect(runPublications(succeededRunId)).resolves.toHaveLength(0);
    await expect(runPublications(failedRunId)).resolves.toEqual([
      { payload: expect.objectContaining({ progressState: "failed" }) },
    ]);
  });

  it("keeps a configured bot's final prose inside Paperclip", async () => {
    const runId = await insertRun("succeeded");
    await expect(
      resolveChatRunPresentationAuthorizationReason(db, { companyId, issueId, runId }),
    ).resolves.toBe("internal_agent_write");
  });

  it("keeps notices and final prose for a GitHub bot without a review configuration", async () => {
    await db.delete(chatGitHubConfigurations).where(eq(chatGitHubConfigurations.endpointId, endpointId));
    try {
      const runId = await insertRun("succeeded");
      await expect(
        resolveChatRunPresentationAuthorizationReason(db, { companyId, issueId, runId }),
      ).resolves.toBe("allow_chat_run_presentation");
      await enqueueChatRunMilestones(db);
      await expect(runPublications(runId)).resolves.toEqual([
        { payload: expect.objectContaining({ progressState: "completed" }) },
      ]);
    } finally {
      await db.insert(chatGitHubConfigurations).values({
        endpointId, companyId, updatedByUserId: ownerUserId, configuration: reviewConfiguration,
      });
    }
  });
});
