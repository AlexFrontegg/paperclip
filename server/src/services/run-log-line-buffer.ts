export type RunLogStream = "stdout" | "stderr";

export const MAX_RUN_LOG_PIECE_CHARS = 48 * 1024;
export const MAX_UNFINISHED_RUN_LOG_LINE_CHARS = 256 * 1024;

function lastLineBreakIndex(text: string) {
  return Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
}

function firstLineBreakIndex(text: string) {
  const found = [text.indexOf("\n"), text.indexOf("\r")].filter((index) => index >= 0);
  return found.length > 0 ? Math.min(...found) : -1;
}

function isHighSurrogate(code: number) {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Groups whole lines into pieces of at most maxChars; a longer line stays one piece. */
function groupLines(text: string, maxChars: number) {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    const lineEnd = lastLineBreakIndex(rest.slice(0, maxChars));
    const longLineEnd = lineEnd >= 0 ? -1 : firstLineBreakIndex(rest);
    const pieceEnd = lineEnd >= 0 ? lineEnd + 1 : longLineEnd >= 0 ? longLineEnd + 1 : rest.length;
    pieces.push(rest.slice(0, pieceEnd));
    rest = rest.slice(pieceEnd);
  }
  return pieces;
}

/**
 * Splits already-redacted run-log text into stored chunks. Splitting happens
 * after redaction, so a cut here cannot expose a credential. It prefers line
 * breaks and never separates a UTF-16 surrogate pair.
 */
export function splitRedactedRunLogText(text: string, maxChars: number) {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const lineEnd = lastLineBreakIndex(rest.slice(0, maxChars));
    let cutIndex = lineEnd >= 0 ? lineEnd + 1 : maxChars;
    if (lineEnd < 0 && isHighSurrogate(rest.charCodeAt(cutIndex - 1))) cutIndex -= 1;
    chunks.push(rest.slice(0, cutIndex));
    rest = rest.slice(cutIndex);
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

/**
 * Hands each stream's output to redaction in whole lines. Adapter output
 * arrives in arbitrary chunks, and a credential cut between two chunks would
 * otherwise reach the run log in two unrecognizable halves. An unfinished line
 * is held until its line break, the end of the run, or the size limit.
 */
export function createRunLogLineBuffer(
  options: { maxPieceChars?: number; maxUnfinishedLineChars?: number } = {},
) {
  const maxPieceChars = options.maxPieceChars ?? MAX_RUN_LOG_PIECE_CHARS;
  const maxUnfinishedLineChars = options.maxUnfinishedLineChars ?? MAX_UNFINISHED_RUN_LOG_LINE_CHARS;
  const heldText: Record<RunLogStream, string> = { stdout: "", stderr: "" };

  return {
    take(stream: RunLogStream, chunk: string): string[] {
      const text = heldText[stream] + chunk;
      let completeLength = lastLineBreakIndex(text) + 1;
      if (text.length - completeLength > maxUnfinishedLineChars) completeLength = text.length;
      heldText[stream] = text.slice(completeLength);
      return groupLines(text.slice(0, completeLength), maxPieceChars);
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
