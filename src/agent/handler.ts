// WeChat message handler backed by the Claude Agent SDK.
//
// Intake runs inside the bot's per-user queue and returns quickly; the agent
// runs in the background so /stop and /status stay responsive. One task runs
// per user at a time. A task is one query() in streaming input mode: messages
// that arrive while it runs are pushed into its live input (see input.ts) and
// steer it, and every result is sent back as its own reply. Messages that
// arrive after the input closed are queued and start the next task.

import fs from "node:fs";
import path from "node:path";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { reply } from "../bot.ts";
import type { BotContext, MessageHandler } from "../bot.ts";
import { humanAge, saveInboundMedia } from "../files.ts";
import { parseMessage } from "../ilink/inbound.ts";
import { describeError, log } from "../log.ts";
import { WORKSPACE_DIR } from "../store.ts";
import {
  BUILTIN_TOOLS,
  MAX_BUDGET_USD,
  MAX_TURNS,
  MEMORY_SCAN_MINUTES,
  MODELS,
  SESSION_IDLE_HOURS,
  agentEnv,
  checkMemoryScanSettings,
  checkSessionIdleHours,
  isModelKey,
  systemPrompt,
} from "./config.ts";
import type { ModelKey } from "./config.ts";
import { workspaceGuard } from "./guard.ts";
import { TaskInput, answeredBy } from "./input.ts";
import { MEMORY_LOCK_FILE, MemoryScanScheduler, SCAN_TIMEOUT_MS, scanTranscripts } from "./memory-scan.ts";
import { MemoryLock, capIndex, loadMemories, syncMemoryIndex } from "./memory.ts";
import { RULES_FILE, RulesTracker, rulesChangeNotice, rulesDisclosure, seedRules, snapshotRules } from "./rules.ts";
import { NO_SESSION, accountRun, resumePrevious, retire, rotationDueAt, shouldRotate } from "./session.ts";
import type { RetireReason } from "./session.ts";
import { AgentStateStore } from "./state.ts";
import type { AgentUserState } from "./state.ts";
import { ALFRED_TOOL_NAMES, createAlfredTools } from "./tools.ts";

const PROGRESS_INTERVAL_MS = 3 * 60_000;
const WORKSPACE_SUBDIRS = ["inbox", "reports", "notes", "images", "memory", ".trash"];
/** Memories listed in the /memory reply; the full index is in memory/MEMORY.md. */
const MEMORY_REPLY_LINES = 50;

const TOOL_LABELS: Record<string, string> = {
  WebSearch: "搜索",
  WebFetch: "读网页",
  Read: "读文件",
  Write: "写文件",
  Edit: "改文件",
  Glob: "找文件",
  Grep: "查内容",
};

const HELP = `Alfred 调研助手
直接发任务给我。文件、图片可以先发，再发说明。
任务进行中也可以接着发消息补充或改方向，Alfred 会在当前步骤结束后看到。

/new  开始新会话（清空上下文${SESSION_IDLE_HOURS > 0 ? `；空闲超过 ${SESSION_IDLE_HOURS} 小时也会自动开始` : ""}）
/resume  切回上一个会话
/stop  停止当前任务
/model [sonnet|opus|haiku]  查看或切换模型
/memory  查看长期记忆（要记住、修改或忘记什么，直接说）
/status  当前状态和花费
/help  显示帮助`;

interface Run {
  abort: AbortController;
  /** Live input of the task's query: the prompt and follow-ups sent while it runs. */
  input: TaskInput;
  startedAt: number;
  toolCounts: Map<string, number>;
  stopped: boolean;
}

interface UserRuntime {
  /** True from the start of a task until the queue is drained. */
  busy: boolean;
  run?: Run;
  /** Prompts received after the running task stopped taking follow-ups; they start the next task. */
  queue: string[];
  /** Files received since the last text message, relative to the workspace. */
  attachments: string[];
}

type ExecOutcome =
  | { kind: "done" }
  | { kind: "stopped" }
  | { kind: "resume-failed"; detail: string };

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

function toolSummary(counts: Map<string, number>): string {
  const parts = [...counts].map(([name, n]) => `${TOOL_LABELS[name] ?? name.replace(/^mcp__alfred__/, "")} ${n} 次`);
  return parts.length ? parts.join("，") : "还没用工具";
}

function sessionStatus(user: AgentUserState, now: number): string {
  if (!user.sessionId) return "新会话";
  const age = user.sessionStartedAt ? `，已开 ${humanAge(now - Date.parse(user.sessionStartedAt))}` : "";
  return `${user.sessionId.slice(0, 8)}${age}，本会话花费 ${usd(user.sessionCostUsd)}`;
}

function idleStatus(user: AgentUserState, now: number): string {
  const idle = user.lastRunAt ? humanAge(now - Date.parse(user.lastRunAt)) : "未知";
  if (SESSION_IDLE_HOURS <= 0) return `${idle}（自动开新会话已关闭）`;
  const due = rotationDueAt(user, SESSION_IDLE_HOURS);
  if (due === undefined) return idle;
  if (now > due) return `${idle}，下一个任务会开新会话`;
  return `${idle}，再过 ${humanAge(due - now)} 下一个任务会开新会话`;
}

/** WeChat reply for one result. */
function resultReply(result: SDKResultMessage): string {
  if (result.subtype === "success") {
    return result.is_error ? `出错了：${result.result}` : result.result.trim() || "完成。";
  }
  if (result.subtype === "error_max_turns") return `任务步骤超过 ${MAX_TURNS} 步，已中止。发“继续”可以接着做。`;
  if (result.subtype === "error_max_budget_usd") {
    return `本次任务花费超过上限 ${usd(MAX_BUDGET_USD)}，已中止。发“继续”可以接着做，或者把任务拆小。`;
  }
  return `执行出错：${result.errors.join("; ") || result.subtype}`;
}

export function buildPrompt(text: string, opts: { attachments: string[]; quotedText?: string; voice: boolean }): string {
  const sections: string[] = [];
  if (opts.attachments.length) {
    sections.push(`Attached files (workspace paths):\n${opts.attachments.map((a) => `- ${a}`).join("\n")}`);
  }
  if (opts.quotedText) sections.push(`Quoted message:\n> ${opts.quotedText.replace(/\n/g, "\n> ")}`);
  sections.push(opts.voice ? `(Voice message, server transcript)\n${text}` : text);
  return sections.join("\n\n");
}

/** Create the workspace layout and seed the root ALFRED.md; shared with scripts/agent-smoke.ts. */
export function prepareWorkspace(): void {
  for (const dir of WORKSPACE_SUBDIRS) fs.mkdirSync(path.join(WORKSPACE_DIR, dir), { recursive: true });
  if (seedRules(WORKSPACE_DIR)) log.info(`seeded ${path.join(WORKSPACE_DIR, RULES_FILE)}`);
}

/** Reply listing the ALFRED.md files a run created, changed or removed, so rule changes never go unnoticed. */
async function notifyRuleChanges(ctx: BotContext, userId: string, before: Map<string, string>): Promise<void> {
  const notice = rulesChangeNotice(before, snapshotRules(WORKSPACE_DIR));
  if (!notice) return;
  log.info(`workspace rules changed: ${notice.replace(/\n/g, "; ")}`);
  await reply(ctx, userId, notice).catch((err) => log.warn(`rules notice failed: ${describeError(err)}`));
}

/** SDK options for one run; shared with scripts/agent-smoke.ts so local tests match production. */
export function agentOptions(params: {
  ctx: BotContext;
  userId: string;
  model: ModelKey;
  resume?: string;
  abortController?: AbortController;
}): Options {
  const memory = capIndex(syncMemoryIndex(WORKSPACE_DIR));
  if (memory.lines.length < memory.total) {
    log.warn(`memory index over its cap: injecting ${memory.lines.length} of ${memory.total} memories`);
  }
  const rules = new RulesTracker(WORKSPACE_DIR);
  const disclosure = rulesDisclosure(rules);
  return {
    model: MODELS[params.model],
    cwd: WORKSPACE_DIR,
    env: agentEnv(),
    settingSources: [],
    systemPrompt: systemPrompt(new Date(), { rootRules: rules.loadRoot(), memory }),
    tools: BUILTIN_TOOLS,
    allowedTools: [...BUILTIN_TOOLS, ...ALFRED_TOOL_NAMES],
    permissionMode: "dontAsk",
    mcpServers: { alfred: createAlfredTools(params.ctx, params.userId, params.abortController?.signal) },
    hooks: {
      PreToolUse: [workspaceGuard(WORKSPACE_DIR)],
      PostToolUse: [disclosure],
      PostToolUseFailure: [disclosure],
    },
    maxTurns: MAX_TURNS,
    maxBudgetUsd: MAX_BUDGET_USD,
    resume: params.resume,
    abortController: params.abortController,
    stderr: (data) => log.debug(`claude: ${data.trimEnd()}`),
  };
}

export function createAgentHandler(): MessageHandler {
  agentEnv(); // Fail at startup, not on the first message, if gateway credentials are missing.
  checkSessionIdleHours();
  checkMemoryScanSettings();
  prepareWorkspace();

  const store = new AgentStateStore();
  const runtimes = new Map<string, UserRuntime>();
  const runtime = (userId: string): UserRuntime => {
    let rt = runtimes.get(userId);
    if (!rt) runtimes.set(userId, (rt = { busy: false, queue: [], attachments: [] }));
    return rt;
  };

  // Tasks and memory scans exclude each other through this lock, so the agent
  // and the extraction job never edit memory files at the same time.
  const memoryLock = new MemoryLock(MEMORY_LOCK_FILE);
  const scheduler = new MemoryScanScheduler({
    lock: memoryLock,
    isBusy: () => [...runtimes.values()].some((rt) => rt.busy),
    scan: () => scanTranscripts({ workspace: WORKSPACE_DIR }),
  });
  if (MEMORY_SCAN_MINUTES > 0) scheduler.start(MEMORY_SCAN_MINUTES * 60_000);

  /**
   * Every session retirement goes through here. It is logged and triggers a
   * memory scan, so the retired transcript is processed while it is fresh; the
   * scan waits until no task is running.
   */
  function retired(userId: string, sessionId: string, reason: RetireReason, note: string): void {
    log.info(`session ${sessionId} retired (${reason}): ${note}`);
    if (MEMORY_SCAN_MINUTES > 0) scheduler.request(`session retired (${reason})`);
  }

  /** Runs the task's query until every message in its input is answered; each result goes to onResult. */
  async function execute(
    ctx: BotContext,
    userId: string,
    run: Run,
    resume: string | undefined,
    onResult: (result: SDKResultMessage) => Promise<void>,
  ): Promise<ExecOutcome> {
    const user = store.get(userId);
    let sessionId: string | undefined;
    let results = 0;
    const q = query({
      prompt: run.input,
      options: agentOptions({ ctx, userId, model: user.model, resume, abortController: run.abort }),
    });
    try {
      for await (const m of q) {
        if (run.stopped) break;
        if (m.type === "system" && m.subtype === "init") {
          // Every turn of a streaming query starts with an init message, so compare with the stored session.
          sessionId = m.session_id;
          if (sessionId !== store.get(userId).sessionId) {
            store.update(userId, { sessionId, sessionCostUsd: 0, sessionStartedAt: new Date().toISOString() });
          }
        } else if (m.type === "assistant") {
          for (const block of m.message.content) {
            if (block.type === "tool_use") run.toolCounts.set(block.name, (run.toolCounts.get(block.name) ?? 0) + 1);
          }
        } else if (m.type === "result") {
          if (resume && results === 0 && m.is_error && m.num_turns === 0) {
            run.input.rewind(); // The retry in a new session gets the same messages.
            return { kind: "resume-failed", detail: m.subtype === "success" ? m.result : m.errors.join("; ") };
          }
          results++;
          run.input.settle(answeredBy(m));
          await onResult(m);
        }
      }
    } catch (err) {
      if (run.stopped) return { kind: "stopped" };
      if (resume && !sessionId) {
        run.input.rewind();
        return { kind: "resume-failed", detail: describeError(err) };
      }
      // After an error result the CLI exits non-zero once its input closes; by then everything was answered.
      if (results > 0 && run.input.pending === 0) return { kind: "done" };
      throw err;
    }
    if (run.stopped) return { kind: "stopped" };
    if (run.input.pending) throw new Error(`agent ended with ${run.input.pending} unanswered message(s)`);
    return { kind: "done" };
  }

  async function runAgent(ctx: BotContext, userId: string, prompt: string): Promise<void> {
    const rt = runtime(userId);
    const run: Run = {
      abort: new AbortController(),
      input: new TaskInput(prompt),
      startedAt: Date.now(),
      toolCounts: new Map(),
      stopped: false,
    };
    rt.run = run;
    const rulesBefore = snapshotRules(WORKSPACE_DIR);
    const stopTyping = await ctx.typing.start(userId);
    const progress = setInterval(() => {
      reply(ctx, userId, `仍在处理（${humanAge(Date.now() - run.startedAt)}）：${toolSummary(run.toolCounts)}`).catch((err) =>
        log.warn(`progress note failed: ${describeError(err)}`),
      );
    }, PROGRESS_INTERVAL_MS);

    let locked = false;
    let replies = 0;
    let cost = 0;
    const onResult = async (result: SDKResultMessage): Promise<void> => {
      // total_cost_usd is cumulative across the turns of this query, so each result is accounted on its own.
      const { deltaUsd, ...spend } = accountRun(store.get(userId), result.total_cost_usd);
      store.update(userId, spend);
      replies++;
      cost += deltaUsd;
      log.info(`agent turn done subtype=${result.subtype} turns=${result.num_turns} cost=${usd(deltaUsd)}`);
      // A failed send must not end the query while later turns are still coming.
      await reply(ctx, userId, resultReply(result)).catch((err) => log.error(`reply failed: ${describeError(err)}`));
    };

    try {
      locked = await memoryLock.acquire("task", SCAN_TIMEOUT_MS + 30_000, run.abort.signal);
      if (run.stopped) {
        log.info("agent run stopped by user while waiting for a memory scan");
        return;
      }
      if (!locked) log.warn(`memory lock still held by ${JSON.stringify(memoryLock.current())}; running the task anyway`);
      let before = store.get(userId);
      const idleSession = before.sessionId;
      if (idleSession && shouldRotate(before, run.startedAt, SESSION_IDLE_HOURS)) {
        const idle = humanAge(run.startedAt - Date.parse(before.lastRunAt ?? ""));
        before = store.update(userId, retire(before));
        retired(userId, idleSession, "idle", `idle ${idle} > ${SESSION_IDLE_HOURS}h`);
        await reply(ctx, userId, `距上次对话已超过 ${SESSION_IDLE_HOURS} 小时，已开始新会话（发 /resume 接回上一个会话）。`);
      }
      log.info(`agent run start model=${before.model} resume=${before.sessionId ?? "none"}`);
      let outcome: ExecOutcome = await execute(ctx, userId, run, before.sessionId, onResult);
      if (outcome.kind === "resume-failed") {
        log.warn(`resume of ${before.sessionId} failed (${outcome.detail}); starting a new session`);
        store.update(userId, NO_SESSION);
        if (before.sessionId) retired(userId, before.sessionId, "resume-failed", outcome.detail);
        await reply(ctx, userId, "之前的会话无法恢复，已开始新会话。");
        outcome = await execute(ctx, userId, run, undefined, onResult);
      }
      if (outcome.kind === "stopped") {
        log.info("agent run stopped by user");
        return;
      }
      if (outcome.kind === "resume-failed") throw new Error(outcome.detail);
      log.info(
        `agent run done replies=${replies} cost=${usd(cost)} ` +
          `time=${humanAge(Date.now() - run.startedAt)} tools=[${toolSummary(run.toolCounts)}]`,
      );
    } catch (err) {
      // Close before the first await, so a message arriving while the error reply goes out is queued for the next task.
      run.input.close();
      log.error(`agent run failed: ${describeError(err)}`);
      const missed = run.input.followUps;
      const note = missed ? `\n期间追加的 ${missed} 条消息没有处理，需要的话请重发。` : "";
      await reply(ctx, userId, `执行出错：${describeError(err)}${note}`).catch(() => {});
    } finally {
      run.input.close();
      clearInterval(progress);
      // Stopped and failed tasks count as activity too, so the idle clock restarts after every task.
      // A failed write must not skip the cleanup below or escape from drain().
      try {
        store.update(userId, { lastRunAt: new Date().toISOString() });
      } catch (err) {
        log.error(`saving lastRunAt failed: ${describeError(err)}`);
      }
      // Keep memory/MEMORY.md on disk in step with what the agent wrote, then let scans run again.
      try {
        syncMemoryIndex(WORKSPACE_DIR);
      } catch (err) {
        log.warn(`memory index sync failed: ${describeError(err)}`);
      }
      try {
        if (locked) memoryLock.release();
      } catch (err) {
        log.error(`releasing the memory lock failed: ${describeError(err)}`);
      }
      // Also after a stop or an error: the run may have changed rules before it ended.
      await notifyRuleChanges(ctx, userId, rulesBefore);
      await stopTyping();
      rt.run = undefined;
    }
  }

  async function drain(ctx: BotContext, userId: string, first: string): Promise<void> {
    const rt = runtime(userId);
    rt.busy = true;
    try {
      let prompt: string | undefined = first;
      while (prompt) {
        await runAgent(ctx, userId, prompt);
        const queued = rt.queue.splice(0);
        prompt = queued.length ? queued.join("\n\n---\n\n") : undefined;
      }
    } finally {
      rt.busy = false;
      scheduler.flush();
    }
  }

  async function handleCommand(ctx: BotContext, userId: string, cmd: string, arg: string): Promise<void> {
    const rt = runtime(userId);
    const user = store.get(userId);
    switch (cmd) {
      case "/help":
        return reply(ctx, userId, HELP);

      case "/new":
        if (rt.busy) return reply(ctx, userId, "当前任务还在进行，先发 /stop 或等它完成。");
        if (!user.sessionId) return reply(ctx, userId, "已经是新会话。");
        store.update(userId, retire(user));
        retired(userId, user.sessionId, "new", "/new");
        return reply(ctx, userId, "已开始新会话。发 /resume 可以接回上一个会话。");

      case "/resume": {
        if (rt.busy) return reply(ctx, userId, "当前任务还在进行，先发 /stop 或等它完成。");
        const patch = resumePrevious(user, Date.now());
        if (!patch?.sessionId) return reply(ctx, userId, "没有可以接回的会话。");
        store.update(userId, patch);
        if (user.sessionId) retired(userId, user.sessionId, "resume", `/resume to ${patch.sessionId}`);
        else log.info(`session ${patch.sessionId} resumed`);
        return reply(
          ctx,
          userId,
          `已切回上一个会话 ${patch.sessionId.slice(0, 8)}，下一个任务接着它继续。${user.sessionId ? "再发 /resume 可以换回来。" : ""}`,
        );
      }

      case "/stop": {
        if (!rt.run) return reply(ctx, userId, "当前没有进行中的任务。");
        const dropped = rt.queue.splice(0).length + rt.run.input.followUps;
        rt.run.input.close();
        rt.run.stopped = true;
        rt.run.abort.abort();
        return reply(ctx, userId, dropped ? `已停止当前任务，并清空排队的 ${dropped} 条消息。` : "已停止当前任务。");
      }

      case "/model": {
        if (!arg) return reply(ctx, userId, `当前模型：${user.model}（${MODELS[user.model]}）\n可选：sonnet、opus、haiku`);
        const key = arg.toLowerCase();
        if (!isModelKey(key)) return reply(ctx, userId, "可选模型：sonnet、opus、haiku");
        store.update(userId, { model: key });
        return reply(ctx, userId, `已切换到 ${key}（${MODELS[key]}）${rt.run ? "，从下一个任务开始生效" : ""}。`);
      }

      case "/memory": {
        syncMemoryIndex(WORKSPACE_DIR);
        const memories = loadMemories(WORKSPACE_DIR);
        if (!memories.length) return reply(ctx, userId, "还没有长期记忆。说“记住……”就会记下来。");
        const lines = memories.slice(0, MEMORY_REPLY_LINES).map((m) => `• ${m.name}${m.description ? `：${m.description}` : ""}`);
        if (memories.length > MEMORY_REPLY_LINES) lines.push(`……还有 ${memories.length - MEMORY_REPLY_LINES} 条，见 memory/MEMORY.md`);
        return reply(ctx, userId, `长期记忆（${memories.length} 条）：\n${lines.join("\n")}\n\n要修改或忘记哪条，直接告诉我。`);
      }

      case "/status": {
        const now = Date.now();
        const lines = [`模型：${user.model}（${MODELS[user.model]}）`, `会话：${sessionStatus(user, now)}`];
        if (user.sessionId && !rt.run) lines.push(`空闲：${idleStatus(user, now)}`);
        if (user.previousSession) lines.push(`上一个会话：${user.previousSession.sessionId.slice(0, 8)}，发 /resume 接回`);
        lines.push(
          `累计花费：${usd(user.totalCostUsd)}`,
          rt.run ? `任务：进行中 ${humanAge(now - rt.run.startedAt)}，${toolSummary(rt.run.toolCounts)}` : "任务：空闲",
        );
        if (rt.run?.input.followUps) lines.push(`追加消息：${rt.run.input.followUps} 条待 Alfred 处理`);
        if (rt.queue.length) lines.push(`排队：${rt.queue.length} 条`);
        if (rt.attachments.length) lines.push(`待处理附件：${rt.attachments.join("、")}`);
        return reply(ctx, userId, lines.join("\n"));
      }

      default:
        return reply(ctx, userId, `不认识的命令 ${cmd}\n\n${HELP}`);
    }
  }

  return async (ctx, msg) => {
    const userId = msg.from_user_id ?? "";
    const rt = runtime(userId);
    const { text, media, quotedText } = parseMessage(msg);
    const trimmed = text.trim();

    if (trimmed.startsWith("/") && media.length === 0) {
      const [cmd = "", ...rest] = trimmed.split(/\s+/);
      await handleCommand(ctx, userId, cmd.toLowerCase(), rest.join(" "));
      return;
    }

    // Voice notes reach the agent through their transcript; other media is saved for the next prompt.
    const voice = media.some((m) => m.kind === "voice");
    const saved: string[] = [];
    for (const m of media) {
      if (m.kind === "voice") continue;
      try {
        const file = await saveInboundMedia(m, ctx.cdnBaseUrl);
        rt.attachments.push(file.relPath);
        saved.push(file.relPath);
      } catch (err) {
        log.error(`saving ${m.kind} failed: ${describeError(err)}`);
        await reply(ctx, userId, `${m.kind} 保存失败：${describeError(err)}`);
      }
    }

    if (!trimmed) {
      if (voice) await reply(ctx, userId, "这条语音没有转写文字，请再说一遍或者打字。");
      else if (saved.length) await reply(ctx, userId, `已保存 ${saved.join("、")}，告诉我要怎么处理。`);
      return;
    }

    const prompt = buildPrompt(trimmed, { attachments: rt.attachments.splice(0), quotedText, voice });
    if (rt.run?.input.push(prompt)) {
      await reply(ctx, userId, "收到，会在当前步骤结束后转给 Alfred。");
      return;
    }
    if (rt.busy) {
      rt.queue.push(prompt);
      await reply(ctx, userId, "收到，排在当前任务之后处理。发 /stop 可以停止当前任务。");
      return;
    }
    void drain(ctx, userId, prompt);
  };
}
