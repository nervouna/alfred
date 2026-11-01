/** The line that separates the messages of one reply. The app splits a streaming draft at the same line. */
export const SPLIT = "<!-- split -->";

/** The messages of a reply: the text cut at separator lines outside fenced code blocks, each trimmed, empty ones dropped. */
export function splitReply(text: string): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (mark) {
      if (fence === undefined) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = undefined;
    }
    if (fence === undefined && line.trim() === SPLIT) {
      parts.push(current.join("\n"));
      current = [];
    } else {
      current.push(line);
    }
  }
  parts.push(current.join("\n"));
  return parts.map((p) => p.trim()).filter(Boolean);
}
