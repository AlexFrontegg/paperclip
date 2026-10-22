export type RunLogStream = "stdout" | "stderr";

export const MAX_HELD_RUN_LOG_CHARS = 16_384;

function lastLineBreakIndex(text: string) {
  return Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
}

function lastInlineWhitespaceIndex(text: string) {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] === " " || text[index] === "\t") return index;
  }
  return -1;
}

/**
 * Holds each stream's unfinished line so redaction sees whole lines. Adapter
 * output arrives in arbitrary chunks, and a credential cut between two chunks
 * would otherwise reach the run log in two unrecognizable halves.
 */
export function createRunLogLineBuffer(maxHeldChars = MAX_HELD_RUN_LOG_CHARS) {
  const heldText: Record<RunLogStream, string> = { stdout: "", stderr: "" };

  return {
    take(stream: RunLogStream, chunk: string): string {
      const text = heldText[stream] + chunk;
      let readyLength = lastLineBreakIndex(text) + 1;
      if (text.length - readyLength > maxHeldChars) {
        const unfinishedLine = text.slice(readyLength);
        const wordBoundary = lastInlineWhitespaceIndex(unfinishedLine);
        const heldWordLength = unfinishedLine.length - wordBoundary - 1;
        readyLength =
          wordBoundary >= 0 && heldWordLength <= maxHeldChars
            ? readyLength + wordBoundary + 1
            : text.length;
      }
      heldText[stream] = text.slice(readyLength);
      return text.slice(0, readyLength);
    },
    drain(): Array<{ stream: RunLogStream; text: string }> {
      const remaining = (["stdout", "stderr"] as const)
        .filter((stream) => heldText[stream].length > 0)
        .map((stream) => ({ stream, text: heldText[stream] }));
      heldText.stdout = "";
      heldText.stderr = "";
      return remaining;
    },
  };
}
