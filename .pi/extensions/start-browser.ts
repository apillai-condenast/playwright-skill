import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";

const EXECUTABLE_PATH = "/Users/apillai/Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const PLAYWRIGHT_PACKAGE = "@playwright/mcp@0.0.84";
const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

const DEFAULT_PORT = 8931;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_USER_DATA_DIR = "./usr_data_dir";
const DEFAULT_VIEWPORT_SIZE = "1210,786";
const DEFAULT_HEADLESS = false;

function start(cwd: string, {
  port = DEFAULT_PORT,
  host = DEFAULT_HOST,
  userDataDir = DEFAULT_USER_DATA_DIR,
  viewportSize = DEFAULT_VIEWPORT_SIZE,
  headless = DEFAULT_HEADLESS,
  userAgent = DEFAULT_USER_AGENT,
} = {}) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("npx", [
      "-y", PLAYWRIGHT_PACKAGE,
      "--executable-path", EXECUTABLE_PATH,
      "--port", String(port),
      "--host", host,
      "--user-data-dir", userDataDir,
      "--viewport-size", viewportSize,
      "--snapshot-mode=none",
      ...(headless ? ["--headless"] : []),
      ...(userAgent ? ["--user-agent", userAgent] : []),
    ], { cwd, detached: true, stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(`Started background launcher (PID ${child.pid}) for http://${host}:${port}/mcp; readiness not checked.`);
    });
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "start_browser",
    label: "Start browser",
    description: "Launch a local Playwright MCP server in the background.",
    parameters: Type.Object({
      port: Type.Optional(Type.Number({ default: DEFAULT_PORT })),
      host: Type.Optional(Type.String({ default: DEFAULT_HOST })),
      userDataDir: Type.Optional(Type.String({ default: DEFAULT_USER_DATA_DIR })),
      viewportSize: Type.Optional(Type.String({ default: DEFAULT_VIEWPORT_SIZE })),
      headless: Type.Optional(Type.Boolean({ default: DEFAULT_HEADLESS, description: "Pass --headless when true." })),
      userAgent: Type.Optional(Type.String({ default: DEFAULT_USER_AGENT, description: "Browser user agent override (--user-agent). Defaults to the hardcoded Chrome user agent." })),
    }),
    async execute(_id, args, _signal, _onUpdate, ctx) {
      return { content: [{ type: "text", text: await start(ctx.cwd, args) }], details: {} };
    },
  });

  pi.registerCommand("start-browser", {
    description: "Launch Playwright MCP: /start-browser [true|false] [user agent]",
    async handler(args, ctx) {
      const match = args.trim().match(/^(true|false)(?:\s+(.+))?$/);
      if (args.trim() && !match) {
        ctx.ui.notify("Usage: /start-browser [true|false] [user agent]", "error");
        return;
      }
      ctx.ui.notify(await start(ctx.cwd, {
        headless: match ? match[1] === "true" : undefined,
        userAgent: match?.[2],
      }), "info");
    },
  });
}
