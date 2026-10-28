# Documents

A document is a file Alfred delivered, known by its workspace path, with a version for each change. Code: `src/documents/` (`versions.ts` the history, `store.ts` the only writer of `workbench/documents.json`, `register.ts` delivery, `commands.ts` revise and undo, `startup.ts`), `src/agent/revision.ts`, and the revision runs in `src/agent/handler.ts`. Command shapes are in `src/api/schema.ts`.

## Versions

- **The history** is a git repository whose git dir (`workbench/versions.git`, see [State and files](../README.md#state-and-files)) lies outside the workspace, so no tool reaches it, and the guard refuses any `.git` path segment. `versions.ts` decides what is versioned: text files, and any delivered file up to `VERSION_MAX_BYTES` (20 MB).
- **A version** is a commit with a reason: `delivered`, `revised`, `changed` (the end of any other run, or the startup commit) or `undone`.
- **Commits** happen at each delivery, at the end of every run that wrote files (a lost run commits nothing; a background subagent commits its own files when it ends), and at startup. Each gives the documents among its files a version.
- **Delivering** (`deliverDocument`): `deliver` commits the file and registers it, with its kind from the extension and its title from the first level-1 or level-2 heading (Markdown), the `<title>` (HTML) or the file name. Delivering a path again adds a version; delivering it unchanged adds none. A file over 20 MB, or one that fails to commit or register, is sent as a plain file with no document. `move_file` moves the document, or each one under a moved directory.

## Revision

The owner annotates a version on a passage (Markdown and text only) or the whole document, up to 50 at once (`document.revise`).

- **Accepting.** `reviseDocument` refuses the batch, and records nothing, when the daily cap is reached or Alfred is shutting down, and for the store's reasons: no such document, a version that is not current, a batch already queued or running, a passage on a non-text document. The run id is drawn first and the run's record is created only once the store has taken the batch, so a refusal leaves no run behind.
- **Beside the chat and unattended**, as a task run is ([tasks](tasks.md)): the same queue, one side run at a time, its own cap, its spend in the day's. `revisionSettings` gives the model and cap: the document's task's, else the model of the run that made its first `delivered` version (default `sonnet`) and the default task cap.
- **The prompt** gives the batch with every owner-written string as JSON, so a line break cannot pass for the list. The agent revises in place, does not deliver (Alfred posts the result), and answers each annotation with `reply_annotation`, which only revision runs have.
- **The end**, in order: the run's files are committed (the revised document gets a `revised` version, others `changed`); annotations still unanswered go back as `unanswered`, `stopped` or `failed` (answered ones stay resolved); the run is recorded; one message with the document at its version now is posted. A lost run posts nothing, and the owner's next message names it.
- **Stopping.** `run.stop` or `/stop <run id>` aborts a live run or dequeues a waiting one. A shutdown, or a start that finds one marked live or queued, ends it as lost and returns its annotations as `failed`, so a document is never locked by a batch no run will answer.
- **The chat hears of it** through `revisionDeliveries` (the 20 newest), as task deliveries are.

## Undo

`document.undo` (`undoRevision`) undoes the latest revision, named by its run. It changes nothing and is refused unless the document is still at that revision's version, no batch is queued or running, and no file the revision changed differs from its commit. Otherwise those files go back to the revision's parent commit as `Undo revision <run id>`, the documents among them get an `undone` version, and the batch's annotations go back as `undone`, keeping their replies. Revise and undo share one lane, so an undo's checks never interleave with a batch being recorded or another undo.

## Startup

`run` opens the history and the store before the API and the scheduler (`startDocuments`). It commits what changed while Alfred was off as `Changes found at startup`, and when `documents.json` does not exist yet it imports once the files earlier app messages delivered. A failure is logged and Alfred runs without documents: plain-file delivery, no run commits.
