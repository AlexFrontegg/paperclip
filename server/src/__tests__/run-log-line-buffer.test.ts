import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";
import { createRunLogLineBuffer } from "../services/run-log-line-buffer.js";

const FAKE_GITHUB_TOKEN = `ghs_${"FAKEfake0123456789abcdefABCDEF012345"}`;

function persistChunks(chunks: string[], options?: Parameters<typeof createRunLogLineBuffer>[0]) {
  const buffer = createRunLogLineBuffer(options);
  const persisted: string[] = [];
  for (const chunk of chunks) {
    for (const piece of buffer.take("stdout", chunk)) persisted.push(compactRunLogChunk(piece));
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

  it("keeps a credential label with its value when a long line is released", () => {
    const persisted = persistChunks([`${"x ".repeat(8192)}Bearer opaquecredentialvalue`]);

    expect(persisted).toContain("***REDACTED***");
    expect(persisted).not.toContain("opaquecredentialvalue");
  });

  it("passes complete lines through at once and holds only the unfinished line", () => {
    const buffer = createRunLogLineBuffer();

    expect(buffer.take("stdout", "first line\nsecond ")).toEqual(["first line\n"]);
    expect(buffer.take("stdout", "line\n")).toEqual(["second line\n"]);
    expect(buffer.take("stdout", "progress 10%\rprogress 20%\r")).toEqual([
      "progress 10%\rprogress 20%\r",
    ]);
    expect(buffer.drain()).toEqual([]);
  });

  it("keeps stdout and stderr apart", () => {
    const buffer = createRunLogLineBuffer();

    expect(buffer.take("stdout", "out")).toEqual([]);
    expect(buffer.take("stderr", "err\n")).toEqual(["err\n"]);
    expect(buffer.take("stdout", "put\n")).toEqual(["output\n"]);
  });

  it("stores large output without truncating it", () => {
    const line = `${"y".repeat(30_000)}\n`;
    const chunks = [`held start `, `${line}${line}${line}`];

    const persisted = persistChunks(chunks);

    expect(persisted).toBe(chunks.join(""));
    expect(persisted).not.toContain("[paperclip truncated run log chunk:");
  });

  it("releases a long line before its last words and keeps those words", () => {
    const buffer = createRunLogLineBuffer({ maxHeldChars: 30 });

    const released = buffer.take("stdout", "alpha beta gamma delta epsilon zeta eta");

    expect(released).toEqual(["alpha beta gamma "]);
    expect(buffer.drain()).toEqual([{ stream: "stdout", text: "delta epsilon zeta eta" }]);
  });

  it("releases an unbroken run longer than the limits instead of holding it forever", () => {
    const buffer = createRunLogLineBuffer({ maxHeldChars: 20, maxPieceChars: 30 });
    const longRun = "x".repeat(50);

    expect(buffer.take("stdout", longRun)).toEqual(["x".repeat(30)]);
    expect(buffer.drain()).toEqual([{ stream: "stdout", text: "x".repeat(20) }]);
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
