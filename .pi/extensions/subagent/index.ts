import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agent from "./agent/index.ts";
import status from "./status/index.ts";

export default function subagent(pi: ExtensionAPI) {
  agent(pi);
  status(pi);
}
