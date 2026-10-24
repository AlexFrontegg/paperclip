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

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), listPrincipals: vi.fn() }));
vi.mock("@/api/access", () => ({
  accessApi: { listMembers: async () => ({ members: [] }) },
}));
vi.mock("@/api/chatEndpoints", () => ({
  chatEndpointsApi: { listPrincipals: mocks.listPrincipals, revokeLink: vi.fn() },
}));
vi.mock("@/api/githubChat", () => ({ githubChatApi: { lookup: mocks.lookup } }));
vi.mock("@/context/CompanyContext", () => ({ useOptionalCompany: () => null }));
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
    mocks.listPrincipals.mockResolvedValue([]);
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

  // Dialog content renders in a portal outside the container.
  async function click(text: string) {
    const button = [...document.querySelectorAll("button")].find(
      (node) => node.textContent?.trim() === text,
    );
    expect(button, text).toBeDefined();
    flushSync(() => button!.click());
    await settle();
  }

  it("adds a looked-up account as a reviewed author without a sponsor", async () => {
    render(baseConfiguration);
    await click("Add reviewed author");
    expect(document.querySelector("#github-guest-sponsor")).toBeNull();
    const loginInput =
      document.querySelector<HTMLInputElement>("#github-guest-login")!;
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

  it("adds a reviewed author whose GitHub account is linked, for example to a viewer", async () => {
    mocks.listPrincipals.mockResolvedValue([
      { githubUserId: "91", githubLogin: "teammate", externalLabel: "teammate", status: "linked", paperclipUserId: "viewer-user" },
    ]);
    render(baseConfiguration);
    await settle();
    await click("Add reviewed author");
    const loginInput =
      document.querySelector<HTMLInputElement>("#github-guest-login")!;
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setValue.call(loginInput, "teammate");
    flushSync(() =>
      loginInput.dispatchEvent(new Event("input", { bubbles: true })),
    );
    await click("Look up");
    expect(document.body.textContent).not.toContain("already listed");
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

  it("turns on read-only GitHub for the bot's agent", async () => {
    render(baseConfiguration);
    await settle();
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Read-only GitHub for this agent"]',
    );
    expect(toggle).not.toBeNull();
    flushSync(() => toggle!.click());
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseConfiguration,
      agentReadOnlyGitHub: true,
    });
  });
});
