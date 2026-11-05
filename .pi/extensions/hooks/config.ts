export const config = {
  wordLimit: 100, // Exclusive: summaries must contain fewer words.
  timeoutSeconds: 15,
  webhookEnv: "SLACK_TRIGGER_URL",
  envFile: new URL("../../../.env", import.meta.url),
  payloadSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Initial request from the user" },
      agent_response: { type: "string", description: "Work summary with newline-separated bullet points, below wordLimit" },
    },
    required: ["prompt", "agent_response"],
    additionalProperties: false,
  },
  payload: (prompt: string, agent_response: string) => ({ prompt, agent_response }),
};
