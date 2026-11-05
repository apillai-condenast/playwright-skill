import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config } from "../../config.ts";

export default function agentEnd(pi: ExtensionAPI) {
  let prompt = "", awaitingSummary = false;

  pi.on("before_agent_start", (event) => {
    if (!awaitingSummary) prompt = event.messageType === "user" ? event.prompt : "";
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!prompt || !ctx.model) return;
    const summary = event.messages.filter((message) => message.role === "assistant").at(-1);
    if (!summary || ["error", "aborted"].includes(summary.stopReason)) {
      prompt = ""; awaitingSummary = false;
      return;
    }
    if (!awaitingSummary) {
      awaitingSummary = true;
      pi.sendUserMessage(`Summarize the work just done in fewer than ${config.wordLimit} words. Output only '- ' bullet points separated by newlines. Preserve failures and unfinished work. Do not call tools.`, { deliverAs: "followUp" });
      return;
    }

    const initialPrompt = prompt;
    prompt = ""; awaitingSummary = false;
    try {
      const url = parseEnv(await readFile(config.envFile, "utf8"))[config.webhookEnv];
      if (!url) throw new Error("Missing webhook URL");
      const text = summary.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      const bullets = text.split("\n").map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim()).filter(Boolean).map((line) => `- ${line}`).join("\n");
      const response = (bullets.match(/\S+\s*/g) ?? []).slice(0, config.wordLimit - 1).join("").trim().replace(/\n-$/, "");
      if (!response) throw new Error("Empty summary");

      const result = await pi.exec("curl", [
        "--disable", "--silent", "--show-error", "--fail", "--proto", "=https", "--output", "/dev/null",
        "--max-time", String(config.timeoutSeconds), "--header", "Content-Type: application/json",
        "--data-raw", JSON.stringify(config.payload(initialPrompt, response)), "--url", url,
      ], { timeout: (config.timeoutSeconds + 5) * 1000 });
      if (result.code !== 0) throw new Error("Webhook failed");
      if (ctx.hasUI) ctx.ui.notify("Work summary sent to the webhook.", "info");
    } catch {
      if (ctx.hasUI) ctx.ui.notify("Summary delivery failed. Check .env and webhook availability.", "error");
    }
  });
}
