// Kiro's session config options as the fake agent offers them (ACP v1 shape):
// `autopilot` (a boolean, on when Kiro may act without asking) and `model`.

export const KIRO_OPTIONS_V1 = [
  { id: "autopilot", name: "Autopilot", category: "mode", type: "boolean", currentValue: true },
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "auto", options: [{ value: "auto", name: "Auto" }, { value: "claude-sonnet", name: "Claude Sonnet" }] },
];
