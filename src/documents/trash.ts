// What deleting is: a file the agent moves into .trash/. This module only knows the name, so that runs.ts, which the
// document store imports, can use the rule without importing the store back. The store re-exports both.

/** The workspace directory the agent deletes into: a file moved there is gone from the owner's view. */
export const TRASH_DIR = ".trash";

/**
 * Whether a workspace path is under .trash/ at the root of the workspace. A document at such a path is trashed: the
 * store keeps it, with its versions and annotations, but serves none of it until the file is moved out again. Pure, so
 * the workbench, which reads the documents file apart from the store, applies the same rule.
 */
export function isTrashedPath(workspacePath: string): boolean {
  return workspacePath.startsWith(`${TRASH_DIR}/`);
}
