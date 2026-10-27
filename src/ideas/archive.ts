// Archives the open ideas nobody answered within a week (see IDEA_ARCHIVE_MS in store.ts): once at start, then every hour.

import { describeError, log } from "../log.ts";
import type { IdeaStore } from "./store.ts";

const HOUR_MS = 3_600_000;

/**
 * Archives the stale ideas at once and then every `everyMs`, logging one line when any are archived, and returns a
 * function that stops the timer. A failure is logged, and the timer goes on. The timer does not keep the process alive.
 */
export function startArchiving(store: IdeaStore, everyMs = HOUR_MS): () => void {
  const sweep = () => {
    try {
      const archived = store.archiveStale();
      if (archived.length > 0) log.info(`archived ${archived.length} unanswered idea(s): ${archived.map((idea) => idea.id).join(", ")}`);
    } catch (err) {
      log.error(`archiving ideas failed: ${describeError(err)}`);
    }
  };
  sweep();
  const timer = setInterval(sweep, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
