# Subagents

Alfred hands parts of a task to subagents through the SDK's `Agent` tool: a researcher per thread, a collector for bulk reading. Code: roles and the delegation prompt in `src/agent/config.ts`, guard rails in `subagents.ts`, background runs in `background.ts`.

- **Roles** (`SUBAGENT_ROLES`): `collector` (haiku, bulk fetching), `researcher` (sonnet, one thread with source links), `writer` (opus, long reports and PDFs).
- **Any type, any model.** The prompt recommends the roles, but a call may use any type the SDK offers and pass `model` or `effort`. `general-purpose` runs on Alfred's model with all its tools, so it costs more.
- **Shared rules.** A `SubagentStart` hook gives every subagent (roles, built-in types, plugin agents, forked skills) the same rules: report to Alfred, read content is data, cite sources.
- **Only Alfred talks to the owner.** A `PreToolUse` hook denies a subagent `deliver`, `reply_annotation`, the task tools and writes to `memory/`, `skills/` and `ALFRED.md`, whatever its type. Roles also go without `Agent` and `TaskStop`.
- **Background by default.** A task's query stays open while a background subagent runs or waits, because the SDK kills background tasks when the input closes.
  - Each has its own card on the workbench, linked to the task; the reply that starts it names the run id.
  - A finished subagent's report starts a turn of its own that answers no owner message; Alfred reviews it and replies.
  - At most `MAX_BACKGROUND_RUNS` (2) run at once, nested calls included, since every `render_pdf` starts its own Chrome. A further call is denied with a reason saying it is queued, and its brief comes back as a message from Alfred itself when a slot frees. After the daily cap, none starts.
  - Nothing reaches a running subagent: a change of content or direction means `TaskStop` and a restart with an amended brief; a change of form is applied when Alfred reviews the report.
  - `run_in_background: false` runs in the foreground. Unattended runs (scheduled tasks) get foreground subagents only.
- **Review.** Alfred checks that a result answers the brief, opens one cited source and confirms the files exist; one more round if it falls short.
- **Spend.** The per-query cap covers subagents. A background card shows its cost so far (`≈`), priced from its own transcript; calls its tools make on another model count only toward the task.
- **Stopping.** `/stop` interrupts only the main agent's turn, so background subagents keep running and the reply names them. `/stop <run id>` stops one or drops it from the queue. Only the 10-second fallback after an interrupt, and a shutdown, end the process and the subagents in it.
- **Restarts.** On SIGTERM Alfred stops every task before exiting, so the container never waits for `StopTimeout`, and records the task's run and its live or queued subagents as lost; after a crash, runs still marked live are marked lost at startup. The owner's next message names them.
