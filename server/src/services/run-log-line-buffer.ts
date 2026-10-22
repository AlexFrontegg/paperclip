export type RunLogStream = "stdout" | "stderr";

export const MAX_HELD_RUN_LOG_CHARS = 16 * 1024;
export const MAX_RUN_LOG_PIECE_CHARS = 48 * 1024;
const WORDS_KEPT_TOGETHER = 4;

function lastLineBreakIndex(text: string) {
  return Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
}

function isInlineWhitespace(char: string | undefined) {
  return char === " " || char === "\t";
}

/** Cuts before the last few words, so a credential label stays with its value. */
function wordSafeCutIndex(text: string) {
  let wordsSeen = 0;
  let cutIndex = text.length;
  for (let index = text.length - 1; index > 0; index -= 1) {
    if (isInlineWhitespace(text[index]) && !isInlineWhitespace(text[index - 1])) {
      wordsSeen += 1;
      cutIndex = index + 1;
      if (wordsSeen === WORDS_KEPT_TOGETHER) break;
    }
  }
  return cutIndex;
}

/**
 * Hands each stream's output to redaction in whole lines. Adapter output
 * arrives in arbitrary chunks, and a credential cut between two chunks would
 * otherwise reach the run log in two unrecognizable halves. Pieces stay below
 * the persisted chunk size, so joining held text never truncates a chunk.
 */
export function createRunLogLineBuffer(options: { maxHeldChars?: number; maxPieceChars?: number } = {}) {
  const maxHeldChars = options.maxHeldChars ?? MAX_HELD_RUN_LOG_CHARS;
  const maxPieceChars = options.maxPieceChars ?? MAX_RUN_LOG_PIECE_CHARS;
  const heldText: Record<RunLogStream, string> = { stdout: "", stderr: "" };

  return {
    take(stream: RunLogStream, chunk: string): string[] {
      let text = heldText[stream] + chunk;
      const pieces: string[] = [];
      while (text.length > 0) {
        const window = text.slice(0, maxPieceChars);
        const lineEnd = lastLineBreakIndex(window);
        if (lineEnd >= 0) {
          pieces.push(text.slice(0, lineEnd + 1));
          text = text.slice(lineEnd + 1);
          continue;
        }
        if (text.length <= maxHeldChars) break;
        const cutIndex = wordSafeCutIndex(window);
        pieces.push(text.slice(0, cutIndex));
        text = text.slice(cutIndex);
      }
      heldText[stream] = text;
      return pieces;
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
