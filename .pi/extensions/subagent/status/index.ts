import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { STATUS_EVENT, type RunStats, type SubagentEvent } from "../state.ts";

export default function (pi: ExtensionAPI) {
  const running = new Map<string, Pick<RunStats, "name" | "startedAt" | "tokens" | "cost">>();
  pi.events.on(STATUS_EVENT, (data) => {
    const event = data as SubagentEvent;
    if (event.type === "start") running.set(event.id, { name: event.name, startedAt: event.startedAt, tokens: 0, cost: 0 });
    if (event.type === "usage") {
      const entry = running.get(event.id);
      if (entry) Object.assign(entry, { tokens: event.tokens, cost: event.cost });
    }
    if (event.type === "end") running.delete(event.id);
  });
  pi.on("session_shutdown", () => running.clear());

  const formatTokens = (tokens: number) => {
    if (tokens < 1000) return String(tokens);
    const scale = tokens >= 1_000_000 ? 1_000_000 : 1000;
    const suffix = scale === 1_000_000 ? "M" : "k";
    return `${Number((tokens / scale).toFixed(1))}${suffix}`;
  };

  const formatTime = (milliseconds: number) => {
    const seconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;
    return [
      ...(hours ? [`${hours}h`] : []),
      ...(hours || minutes ? [`${minutes}m`] : []),
      `${remainingSeconds}s`,
    ].join(" ");
  };

  function statusLines(
    ctx: ExtensionContext,
    colorName: (text: string) => string = (text) => text,
    colorCost: (text: string) => string = (text) => text,
    colorTime: (text: string) => string = (text) => text,
    colorError: (text: string) => string = (text) => text,
  ): string[] {
    const past = ctx.sessionManager.getBranch()
      .filter((entry) => entry.type === "custom" && entry.customType === "subagent-run")
      .map((entry) => entry.data as RunStats);
    const active = [...running.values()];
    if (active.length === 0 && past.length === 0) return [];

    const now = Date.now();
    const rows = [
      ...active.map(({ name, startedAt, tokens, cost }) => ({
        name, tokens: formatTokens(tokens), cost: `$${cost.toFixed(2)}`,
        time: formatTime(now - startedAt), status: "running",
      })),
      ...past.map(({ name, elapsedMs, tokens, cost, status }) => ({
        name, tokens: formatTokens(tokens), cost: `$${cost.toFixed(2)}`,
        time: formatTime(elapsedMs), status: status === "completed" ? "done" : status,
      })),
    ];
    const total = [...active.map((run) => ({ ...run, elapsedMs: now - run.startedAt })), ...past].reduce(
      (sum, run) => ({ tokens: sum.tokens + run.tokens, cost: sum.cost + run.cost, elapsedMs: sum.elapsedMs + run.elapsedMs }),
      { tokens: 0, cost: 0, elapsedMs: 0 },
    );
    const columns = ["Name", "Tokens", "Cost", "Time", "Status"];
    const widths = [
      Math.max(columns[0].length, "Total".length, ...rows.map((row) => row.name.length)),
      Math.max(columns[1].length, ...rows.map((row) => row.tokens.length), formatTokens(total.tokens).length),
      Math.max(columns[2].length, ...rows.map((row) => row.cost.length), `$${total.cost.toFixed(2)}`.length),
      Math.max(columns[3].length, ...rows.map((row) => row.time.length), formatTime(total.elapsedMs).length),
      Math.max(columns[4].length, ...rows.map((row) => row.status.length)),
    ];
    const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
    const rowLine = (row: (typeof rows)[number]) => [
      `${colorName(row.name)}${" ".repeat(widths[0] - row.name.length)}`,
      row.tokens.padEnd(widths[1]),
      `${colorCost(row.cost)}${" ".repeat(widths[2] - row.cost.length)}`,
      `${colorTime(row.time)}${" ".repeat(widths[3] - row.time.length)}`,
      row.status === "failed" || row.status === "timedout" ? colorError(row.status) : row.status,
    ].join("  ");
    return [
      line(columns),
      line(widths.map((width) => "─".repeat(width))),
      ...rows.map(rowLine),
      line(widths.map((width) => "─".repeat(width))),
      rowLine({ name: "Total", tokens: formatTokens(total.tokens), cost: `$${total.cost.toFixed(2)}`, time: formatTime(total.elapsedMs), status: "" }),
    ];
  }

  pi.registerCommand("subagent-status", {
    description: "Show live subagent status; press Esc to close",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(statusLines(ctx).join("\n") || "No subagents in this session yet", "info");
        return;
      }
      let timer: ReturnType<typeof setInterval> | undefined;
      try {
        await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
          timer = setInterval(() => tui.requestRender(), 500);
          return {
            render(width: number) {
              const lines = statusLines(
                ctx,
                (text) => `\x1b[38;2;150;120;190m${text}\x1b[39m`,
                (text) => theme.fg("success", text),
                (text) => `\x1b[38;2;180;120;255m${text}\x1b[39m`,
                (text) => `\x1b[38;2;180;100;110m${text}\x1b[39m`,
              );
              return [
                theme.fg("accent", "Subagent status (live)"),
                ...(lines.length ? lines : ["No subagents in this session yet"]),
                theme.fg("dim", "Press Esc to close"),
              ].map((line) => truncateToWidth(line, width));
            },
            handleInput(data: string) {
              if (matchesKey(data, "q") || keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) done();
            },
            invalidate() {},
          };
        });
      } finally {
        if (timer) clearInterval(timer);
      }
    },
  });
}
