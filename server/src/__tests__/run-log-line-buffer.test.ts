import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";
import { createRunLogLineBuffer } from "../services/run-log-line-buffer.js";

const FAKE_GITHUB_TOKEN = `ghs_${"FAKEfake0123456789abcdefABCDEF012345"}`;

function persistChunks(chunks: string[], maxHeldChars?: number) {
  const buffer = createRunLogLineBuffer(maxHeldChars);
  const persisted: string[] = [];
  for (const chunk of chunks) {
    const completeLines = buffer.take("stdout", chunk);
    if (completeLines) persisted.push(compactRunLogChunk(completeLines));
  }
  for (const held of buffer.drain()) persisted.push(compactRunLogChunk(held.text));
  return persisted.join("");
}

describe("createRunLogLineBuffer", () => {
  it("redacts a credential that arrives split across two output chunks", () => {
    const line = `  - Token: ${FAKE_GITHUB_TOKEN}\n`;
    const splitAt = line.indexOf(FAKE_GITHUB_TOKEN) + 14;

    const persisted = persistChunks([line.slice(0, splitAt), line.slice(splitAt)]);

    expect(persisted).toContain("***REDACTED***");
    expect(persisted).not.toContain("FAKEfake");
    expect(persisted).not.toContain("abcdefABCDEF012345");
  });

  it("passes complete lines through at once and holds only the unfinished line", () => {
    const buffer = createRunLogLineBuffer();

    expect(buffer.take("stdout", "first line\nsecond ")).toBe("first line\n");
    expect(buffer.take("stdout", "line\n")).toBe("second line\n");
    expect(buffer.take("stdout", "progress 10%\rprogress 20%\r")).toBe(
      "progress 10%\rprogress 20%\r",
    );
    expect(buffer.drain()).toEqual([]);
  });

  it("keeps stdout and stderr apart", () => {
    const buffer = createRunLogLineBuffer();

    expect(buffer.take("stdout", "out")).toBe("");
    expect(buffer.take("stderr", "err\n")).toBe("err\n");
    expect(buffer.take("stdout", "put\n")).toBe("output\n");
  });

  it("releases a long line at a word boundary and keeps only the last word", () => {
    const buffer = createRunLogLineBuffer(20);

    const released = buffer.take("stdout", "alpha beta gamma delta epsilon tail");

    expect(released).toBe("alpha beta gamma delta epsilon ");
    expect(buffer.drain()).toEqual([{ stream: "stdout", text: "tail" }]);
  });

  it("releases an unbroken run longer than the cap instead of holding it forever", () => {
    const buffer = createRunLogLineBuffer(20);
    const longRun = "x".repeat(50);

    expect(buffer.take("stdout", longRun)).toBe(longRun);
    expect(buffer.drain()).toEqual([]);
  });

  it("returns every held tail at the end and then empties", () => {
    const buffer = createRunLogLineBuffer();
    buffer.take("stdout", "last stdout line without newline");
    buffer.take("stderr", "Error: exited");

    expect(buffer.drain()).toEqual([
      { stream: "stdout", text: "last stdout line without newline" },
      { stream: "stderr", text: "Error: exited" },
    ]);
    expect(buffer.drain()).toEqual([]);
  });
});
