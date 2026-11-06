export type RunStats = {
  name: string;
  startedAt: number;
  elapsedMs: number;
  tokens: number;
  cost: number;
  status: "completed" | "failed" | "timedout";
};

export type SubagentEvent =
  | { type: "start"; id: string; name: string; startedAt: number }
  | { type: "usage"; id: string; tokens: number; cost: number }
  | { type: "end"; id: string };

export const STATUS_EVENT = "project-subagent:status";
