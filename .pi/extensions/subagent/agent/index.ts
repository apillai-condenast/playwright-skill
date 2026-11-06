import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { finished } from "node:stream/promises";
import { TextDecoder } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { STATUS_EVENT, type RunStats, type SubagentEvent } from "../state.ts";

function stopChild(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-child.pid, signal);
  } catch {
    // The process may have already exited.
  }
}

async function runSubagent(
  cwd: string,
  name: string,
  prompt: string,
  timeout?: number,
  signal?: AbortSignal,
  onStart?: () => void,
  onUsage?: (tokens: number, cost: number) => void,
  onChild?: (child: ChildProcess) => void,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error("Name must contain only letters, digits, underscores, or hyphens (starting with a letter or digit).");
  }
  if (!prompt.trim()) throw new Error("Prompt must not be empty.");
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483)) {
    throw new Error("Timeout must be an integer between 1 and 2147483 seconds.");
  }
  signal?.throwIfAborted();

  const sessionDir = join(cwd, ".pi-sessions");
  const dir = join(sessionDir, "subagents", name);
  await mkdir(dir, { recursive: true });
  const stamp = `${new Date().toISOString().replace(/[:.]/g, "-")}_${randomUUID().slice(0, 8)}`;
  const promptPath = join(dir, `prompt_${stamp}.txt`);
  const outputPath = join(dir, `output_${stamp}.txt`);
  await writeFile(promptPath, prompt, { flag: "wx", mode: 0o600 });

  // @path is an initial-prompt file. JSON mode provides usage and a final response.
  const output = await open(outputPath, "wx", 0o600);
  const log = createWriteStream(outputPath, { fd: output.fd, autoClose: false });
  let exitCode: number | null;
  let response = "";
  let tokens = 0;
  let cost = 0;
  let error = false;
  let timedOut = false;
  const decoder = new TextDecoder();
  let pending = "";
  const processLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type !== "message_end") return;
      const message = event.message;
      if (message?.role === "assistant") {
        response = (message.content as Array<{ type: string; text?: string }>)
          .filter((part) => part.type === "text")
          .map((part) => part.text ?? "")
          .join("");
        error = message.stopReason === "error" || message.stopReason === "aborted";
      }
      if (message?.role === "assistant" || message?.role === "toolResult") {
        const usage = message.usage;
        if (usage) {
          tokens += (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          cost += usage.cost?.total ?? 0;
          onUsage?.(tokens, cost);
        }
      }
    } catch {
      // Ignore non-JSON diagnostics; they remain in the output log.
    }
  };
  try {
    onStart?.();
    exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("pi", ["--mode", "json", "--session-dir", sessionDir, `@./.pi-sessions/subagents/${name}/prompt_${stamp}.txt`], {
        cwd,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", output.fd],
      });
      onChild?.(child);
      child.stdout.pipe(log, { end: false });
      child.stdout.on("data", (chunk: Buffer) => {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      const abort = () => stopChild(child, "SIGTERM");
      let finishTermination: Promise<void> | undefined;
      const timeoutTimer = timeout === undefined ? undefined : setTimeout(() => {
        timedOut = true;
        stopChild(child, "SIGTERM");
        // The parent may exit before its descendants. Keep the process-group kill scheduled.
        finishTermination = new Promise((resolveTermination) => {
          setTimeout(() => {
            stopChild(child, "SIGKILL");
            resolveTermination();
          }, 5000);
        });
      }, timeout * 1000);
      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        signal?.removeEventListener("abort", abort);
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", async (code) => {
        cleanup();
        await finishTermination;
        resolve(code);
      });
    });
    pending += decoder.decode();
    processLine(pending);
  } finally {
    log.end();
    try {
      await finished(log);
    } finally {
      await output.close();
    }
  }
  return { promptPath: relative(cwd, promptPath), outputPath: relative(cwd, outputPath), exitCode, response: response.trim().slice(-50_000), tokens, cost, error: error || timedOut, timedOut };
}

export default function (pi: ExtensionAPI) {
  const children = new Set<ChildProcess>();
  let shuttingDown = false;

  pi.on("session_shutdown", async () => {
    shuttingDown = true;
    await Promise.all([...children].map((child) => new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timeout = setTimeout(() => {
        stopChild(child, "SIGKILL");
        resolve();
      }, 5000);
      child.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      stopChild(child, "SIGTERM");
    })));
  });

  async function runWithFeedback(ctx: ExtensionContext, name: string, prompt: string, timeout?: number, signal?: AbortSignal) {
    const id = randomUUID();
    let startedAt: number | undefined;
    let tokens = 0;
    let cost = 0;
    let result: Awaited<ReturnType<typeof runSubagent>> | undefined;
    let failed = false;
    const emit = (event: SubagentEvent) => pi.events.emit(STATUS_EVENT, event);
    try {
      result = await runSubagent(ctx.cwd, name, prompt, timeout, signal, () => {
        startedAt = Date.now();
        emit({ type: "start", id, name, startedAt });
        if (ctx.hasUI) ctx.ui.notify(`Subagent ${name} started running the prompt`, "info");
      }, (nextTokens, nextCost) => {
        tokens = nextTokens;
        cost = nextCost;
        emit({ type: "usage", id, tokens, cost });
      }, (child) => {
        children.add(child);
        child.once("close", () => children.delete(child));
        if (shuttingDown) stopChild(child, "SIGTERM");
      });
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (startedAt !== undefined) {
        const record: RunStats = {
          name, startedAt, tokens, cost,
          elapsedMs: Date.now() - startedAt,
          status: result?.timedOut ? "timedout" : failed || result?.exitCode !== 0 || result?.error ? "failed" : "completed",
        };
        pi.appendEntry("subagent-run", record);
        emit({ type: "end", id });
      }
    }
  }

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: "Run a separate Pi agent with a saved prompt. Saves prompt and combined stdout/stderr in .pi-sessions/subagents/<name>/, stores Pi sessions under .pi-sessions/, and returns only the agent's response.",
    parameters: Type.Object({
      name: Type.String({ description: "Subagent name (also its folder name)" }),
      prompt: Type.String({ description: "Initial prompt to write to a file and pass to pi as @path" }),
      timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483, description: "Maximum runtime in seconds; no limit if omitted" })),
    }),
    async execute(_id, { name, prompt, timeout }, signal, _onUpdate, ctx) {
      const result = await runWithFeedback(ctx, name, prompt, timeout, signal);
      return {
        content: [{ type: "text", text: result.timedOut ? `Subagent ${name} timed out after ${timeout} seconds.` : result.response || `Subagent exited with code ${result.exitCode} without a response.` }],
        details: result,
        isError: result.exitCode !== 0 || result.error,
      };
    },
  });

  pi.registerCommand("subagent", {
    description: "Run a subagent: /subagent <name> <prompt>",
    handler: async (args, ctx) => {
      const match = args.match(/^\s*(\S+)\s+([\s\S]*\S)\s*$/);
      if (!match) {
        ctx.ui.notify("Usage: /subagent <name> <prompt>", "error");
        return;
      }
      try {
        const result = await runWithFeedback(ctx, match[1], match[2]);
        ctx.ui.notify(`Subagent ${match[1]} exited ${result.exitCode}`, result.exitCode === 0 ? "info" : "error");
        pi.sendUserMessage(result.response || `Subagent exited with code ${result.exitCode} without a response.`, { deliverAs: "followUp" });
      } catch (error) {
        ctx.ui.notify(`Subagent failed: ${String(error)}`, "error");
      }
    },
  });
}
