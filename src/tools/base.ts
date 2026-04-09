import type { ToolDefinition } from "../providers/base.js";

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly concurrencySafe?: boolean;
  readonly parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): Promise<string>;
}

export function toolParam(
  type: "string" | "number" | "boolean" | "integer",
  description: string,
  options?: { default?: unknown; minimum?: number; enum?: string[] }
) {
  const schema: Record<string, unknown> = { type: type === "integer" ? "number" : type, description };
  if (options?.default !== undefined) schema.default = options.default;
  if (options?.minimum !== undefined) schema.minimum = options.minimum;
  if (options?.enum) schema.enum = options.enum;
  return schema;
}

export function buildToolDefinition(tool: Tool): ToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}
