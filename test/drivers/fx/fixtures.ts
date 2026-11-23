// fx's session config options as the fake agent offers them: a provider select
// and a model select (whose values depend on the provider), in ACP v1's shape.

export const FX_OPTIONS_V1 = [
  {
    id: "provider",
    name: "Provider",
    category: "other",
    type: "select",
    currentValue: "openai",
    options: [
      { value: "openai", name: "OpenAI" },
      { value: "anthropic", name: "Anthropic" },
    ],
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "gpt-5",
    options: [
      { value: "gpt-5", name: "GPT-5" },
      { value: "gpt-5-mini", name: "GPT-5 mini" },
    ],
  },
];
