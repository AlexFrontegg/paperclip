// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultGitHubReviewPolicy,
  type GitHubChatConfiguration,
} from "@paperclipai/shared";
import { GitHubAccessEditor } from "./GitHubBotConfiguration";

const mocks = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("@/api/access", () => ({
  accessApi: { listMembers: async () => ({ members: [] }) },
}));
vi.mock("@/api/chatEndpoints", () => ({
  chatEndpointsApi: { listPrincipals: async () => [], revokeLink: vi.fn() },
}));
vi.mock("@/api/githubChat", () => ({ githubChatApi: { lookup: mocks.lookup } }));
vi.mock("@/lib/router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const baseConfiguration: GitHubChatConfiguration = {
  version: 1,
  toolsEnabled: true,
  responsibleUserId: "owner-user",
  memberAccess: "all_linked",
  people: [],
  defaults: defaultGitHubReviewPolicy(),
  repositories: {},
};

describe("GitHubAccessEditor reviewed authors", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onChange: ReturnType<
    typeof vi.fn<(configuration: GitHubChatConfiguration) => void>
  >;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onChange = vi.fn<(configuration: GitHubChatConfiguration) => void>();
    mocks.lookup.mockResolvedValue({ githubUserId: "91", login: "teammate" });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  async function settle() {
    for (let attempt = 0; attempt < 5; attempt += 1)
      await new Promise((resolve) => setTimeout(resolve, 0));
    flushSync(() => {});
  }

  function render(configuration: GitHubChatConfiguration) {
    flushSync(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <GitHubAccessEditor
            endpointId="endpoint-a"
            companyId="company-a"
            configuration={configuration}
            onChange={onChange}
          />
        </QueryClientProvider>,
      ),
    );
  }

  async function click(text: string) {
    const button = [...container.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    );
    expect(button, text).toBeDefined();
    flushSync(() => button!.click());
    await settle();
  }

  it("adds a looked-up account as a reviewed author without a sponsor", async () => {
    render(baseConfiguration);
    await click("Add reviewed author");
    expect(container.textContent).not.toContain("Sponsor");
    const loginInput =
      container.querySelector<HTMLInputElement>("#github-guest-login")!;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setValue.call(loginInput, "teammate");
    flushSync(() =>
      loginInput.dispatchEvent(new Event("input", { bubbles: true })),
    );
    await click("Look up");
    expect(mocks.lookup).toHaveBeenCalledWith("endpoint-a", "teammate");
    await click("Add this account");
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseConfiguration,
      reviewedAuthors: [{ githubUserId: "91", login: "teammate" }],
    });
  });

  it("removes a reviewed author", async () => {
    render({
      ...baseConfiguration,
      reviewedAuthors: [{ githubUserId: "91", login: "teammate" }],
    });
    await settle();
    expect(container.textContent).toContain("@teammate");
    await click("Remove");
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseConfiguration,
      reviewedAuthors: [],
    });
  });
});
