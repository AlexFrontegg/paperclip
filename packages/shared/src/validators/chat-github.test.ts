import { describe, expect, it } from "vitest";
import { defaultGitHubReviewPolicy } from "../types/chat-github.js";
import { githubChatConfigurationSchema } from "./chat-github.js";

const configuration = {
  version: 1,
  toolsEnabled: true,
  responsibleUserId: "owner",
  memberAccess: "all_linked",
  people: [],
  defaults: defaultGitHubReviewPolicy(),
  repositories: {},
};

describe("githubChatConfigurationSchema reviewed authors", () => {
  it("accepts configurations saved before reviewed authors existed", () => {
    expect(githubChatConfigurationSchema.safeParse(configuration).success).toBe(true);
  });

  it("rejects an account that is both an allowed person and a reviewed author", () => {
    const result = githubChatConfigurationSchema.safeParse({
      ...configuration,
      people: [
        {
          kind: "guest",
          githubUserId: "42",
          login: "author",
          automaticReviews: false,
          sponsorUserId: "owner",
          permissionProfile: "restricted",
        },
      ],
      reviewedAuthors: [{ githubUserId: "42", login: "author" }],
    });
    expect(result.success).toBe(false);
  });
});
