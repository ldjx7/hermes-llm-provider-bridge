export function buildStructuredPrompt(request, context) {
  const payload = {
    profile: context.profileName,
    requested_model: request.model,
    backend_model: context.model?.backendModel || context.model?.id,
    messages: request.messages || [],
    tools: request.tools || [],
    tool_choice: request.tool_choice || "auto"
  };

  return [
    "You are acting as the reasoning model behind an OpenAI-compatible provider bridge.",
    "Do not execute tools yourself. If a tool is needed, request it in structured JSON and let the caller execute it.",
    "Return exactly one JSON object and no surrounding Markdown.",
    "",
    "For a final answer:",
    "{\"type\":\"final\",\"content\":\"text\"}",
    "",
    "For tool calls:",
    "{\"type\":\"tool_calls\",\"tool_calls\":[{\"name\":\"tool_name\",\"arguments\":{\"key\":\"value\"}}]}",
    "",
    "Only use tool names that appear in the provided tools list.",
    "Here is the request payload:",
    JSON.stringify(payload)
  ].join("\n");
}

export function buildRepairPrompt({ originalPrompt, badOutput, errorMessage }) {
  return [
    "The previous response was not valid bridge JSON.",
    `Parser error: ${errorMessage}`,
    "",
    "Rewrite the response as exactly one JSON object and no surrounding Markdown.",
    "Allowed final answer shape:",
    "{\"type\":\"final\",\"content\":\"text\"}",
    "Allowed tool call shape:",
    "{\"type\":\"tool_calls\",\"tool_calls\":[{\"name\":\"tool_name\",\"arguments\":{\"key\":\"value\"}}]}",
    "",
    "Original bridge instructions:",
    originalPrompt,
    "",
    "Invalid response to repair:",
    badOutput
  ].join("\n");
}
