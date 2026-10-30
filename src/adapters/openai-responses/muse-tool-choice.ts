import { isPlainObject } from "./internal";

export class MuseToolChoiceCompatibilityError extends Error {
  constructor() {
    super("This tool_choice cannot be preserved for Meta Responses; use auto or none.");
    this.name = "MuseToolChoiceCompatibilityError";
  }
}

/** Exact original-choice contract shared by the wire adapter and combo selection. */
export function museAcceptsToolChoice(choice: unknown): boolean {
  return choice === undefined || choice === "auto" || choice === "none";
}

/**
 * Only definitive, structurally recognizable mandatory choices warrant skipping a
 * Meta target in a combo. Invalid selectors must remain ordinary input errors.
 */
/** Recognized allowed_tools selector types; malformed/unknown choices stay input errors. */
const recognizableAllowedToolTypes = new Set([
  "function", "custom", "web_search", "web_search_preview",
  "file_search", "code_interpreter", "image_generation",
  "computer_use", "computer_use_preview", "mcp", "local_shell", "shell",
]);

function recognizableAllowedTool(tool: unknown): boolean {
  if (!isPlainObject(tool) || typeof tool.type !== "string"
    || !recognizableAllowedToolTypes.has(tool.type)) return false;
  if (tool.type === "function" || tool.type === "custom") {
    return typeof tool.name === "string" && tool.name.trim().length > 0;
  }
  if (tool.type === "mcp") {
    return typeof tool.server_label === "string" && tool.server_label.trim().length > 0;
  }
  return true;
}

export function museComboChoiceIsKnownIncompatible(choice: unknown): boolean {
  if (choice === "required") return true;
  if (!isPlainObject(choice)) return false;
  if (choice.type === "function") return typeof choice.name === "string" && choice.name.trim().length > 0;
  if (choice.type === "allowed_tools") {
    return (choice.mode === "auto" || choice.mode === "required")
      && Array.isArray(choice.tools) && choice.tools.length > 0
      && choice.tools.every(recognizableAllowedTool);
  }
  return false;
}

function selectorKind(choice: unknown): "auto" | "none" {
  if (!museAcceptsToolChoice(choice)) throw new MuseToolChoiceCompatibilityError();
  return choice === "none" ? "none" : "auto";
}

export function normalizeMuseToolChoice(body: unknown, originalChoice: unknown): unknown {
  const originalKind = selectorKind(originalChoice);
  const effectiveKind = selectorKind(isPlainObject(body) ? body.tool_choice : undefined);
  if (originalKind !== "none" && effectiveKind !== "none") return body;
  if (!isPlainObject(body)) return body;

  const input = Array.isArray(body.input)
    ? body.input.filter(item => !isPlainObject(item) || item.type !== "additional_tools")
    : body.input;
  const {
    tool_choice: _toolChoice,
    parallel_tool_calls: _parallelToolCalls,
    ...rest
  } = body;
  return { ...rest, tools: [], ...(input !== body.input ? { input } : {}) };
}
