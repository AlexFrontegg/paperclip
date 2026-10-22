import { describe, expect, it } from "vitest";
import { compactRunLogChunk } from "../services/heartbeat.js";
import { createRunLogLineBuffer, splitRedactedRunLogText } from "../services/run-log-line-buffer.js";

const FAKE_GITHUB_TOKEN = `ghs_${"FAKEfake0123456789abcdefABCDEF012345"}`;
const STORED_CHUNK_CHARS = 64 * 1024;

function storePiece(piece: string) {
  return splitRedactedRunLogText(compactRunLogChunk(piece, Number.POSITIVE_INFINITY), STORED_CHUNK_CHARS);
}

function persistChunks(chunks: string[], options?: Parameters<typeof createRunLogLineBuffer>[0]) {
  const buffer = createRunLogLineBuffer(options);
  const stored: string[] = [];
  for (const chunk of chunks) {
    for (const piece of buffer.take("stdout", chunk)) stored.push(...storePiece(piece));
  }
  for (const held of buffer.drain()) stored.push(...storePiece(held.text));
  return stored;
}

describe("createRunLogLineBuffer", () => {
  it("redacts a credential that arrives split across two output chunks", () => {
    const line = `  - Token: ${FAKE_GITHUB_TOKEN}\n`;
    const splitAt = line.indexOf(FAKE_GITHUB_TOKEN) + 14;

    const stored = persistChunks([line.slice(0, splitAt), line.slice(splitAt)]).join("");

    expect(stored).toContain("***REDACTED***");
    expect(stored).not.toContain("FAKEfake");
    expect(stored).not.toContain("abcdefABCDEF012345");
  });

  it("redacts a credential at the end of a long line without spaces", () => {
    const line = `${".".repeat(49_142)}ghs_${"A".repeat(36)}\n`;

    const stored = persistChunks([line.slice(0, 49_152), line.slice(49_152)]).join("");

    expect(stored).toContain("***REDACTED***");
    expect(stored).not.toContain("A".repeat(36));
  });

  it("keeps a credential label with its value on a long unfinished line", () => {
    const stored = persistChunks([`${"x ".repeat(8192)}Bearer opaquecredentialvalue`]).join("");

    expect(stored).toContain("***REDACTED***");
    expect(stored).not.toContain("opaquecredentialvalue");
  });

  it("stores large output complete and in chunks no bigger than the stored chunk size", () => {
    const shortLines = `${"y".repeat(30_000)}\n`.repeat(3);
    const longLine = `${"word ".repeat(30_000)}\n`;
    const chunks = ["held start ", shortLines, longLine.slice(0, 70_000), longLine.slice(70_000)];

    const stored = persistChunks(chunks);

    expect(stored.join("")).toBe(chunks.join(""));
    expect(Math.max(...stored.map((chunk) => chunk.length))).toBeLessThanOrEqual(STORED_CHUNK_CHARS);
    expect(stored.join("")).not.toContain("[paperclip truncated run log chunk:");
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

  it("groups lines into pieces and keeps a longer line whole", () => {
    const buffer = createRunLogLineBuffer({ maxPieceChars: 10 });

    expect(buffer.take("stdout", "aa\nbb\ncccccccccccccccc\ndd\n")).toEqual([
      "aa\nbb\n",
      "cccccccccccccccc\n",
      "dd\n",
    ]);
  });

  it("releases an unfinished line that grows past the limit", () => {
    const buffer = createRunLogLineBuffer({ maxUnfinishedLineChars: 20 });

    expect(buffer.take("stdout", "x".repeat(20))).toEqual([]);
    expect(buffer.take("stdout", "x".repeat(5))).toEqual(["x".repeat(25)]);
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

describe("splitRedactedRunLogText", () => {
  it("prefers line breaks and keeps every character", () => {
    const text = "one\ntwo\nthree\n";

    expect(splitRedactedRunLogText(text, 9)).toEqual(["one\ntwo\n", "three\n"]);
  });

  it("never separates a surrogate pair", () => {
    const text = `${"a".repeat(9)}😀tail`;

    const chunks = splitRedactedRunLogText(text, 10);

    expect(chunks.join("")).toBe(text);
    expect(chunks[0]).toBe("a".repeat(9));
  });
});
