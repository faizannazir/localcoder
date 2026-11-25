import { parseArgs } from "node:util";
import { serverPort, serverRequest } from "./server-client";

export async function runVscode(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args, allowPositionals: true,
    options: { port: { type: "string" }, tools: { type: "boolean" }, continue: { type: "boolean" }, "input-tokens": { type: "string" } },
  });
  if (!positionals.length) {
    throw new Error("Usage: localcoder vscode <model-id> [<model-id> ...] [--continue] [--tools] [--port <port>] [--input-tokens <count>]");
  }
  const port = await serverPort(values.port);
  const { data, foundry_error } = await serverRequest<{ data: { id: string; capabilities?: string[]; owned_by?: string }[]; foundry_error?: string }>(port, "/v1/models");
  const selected = [...new Set(positionals)].map((id) => {
    const model = data.find((candidate) => candidate.id === id);
    if (!model) throw new Error((id.startsWith("foundry/") && foundry_error) || `Model "${id}" is unavailable. Check GET /v1/models.`);
    return model;
  });
  const needsRouting = selected.some((model) => model.owned_by !== "foundry-local");
  const budgets = needsRouting ? (await serverRequest<{
    model_contexts: Record<string, { context_window: number; max_output_tokens: number }>;
  }>(port, "/v1/resource")).model_contexts : {};
  const models = selected.map(({ id, capabilities, owned_by }) => {
    const foundry = owned_by === "foundry-local";
    const supportsTools = foundry || capabilities?.includes("tool_calling") === true;
    if (selected.length === 1 && values.tools && !supportsTools) {
      throw new Error(`Model "${id}" has no registered tool-capable chat template.`);
    }
    let input = 8192;
    let output = 1024;
    if (!foundry) {
      const budget = Object.hasOwn(budgets, id) ? budgets[id] : undefined;
      if (!budget) throw new Error(`Model "${id}" does not fit the current memory budget. Run localcoder doctor.`);
      output = Math.min(budget.max_output_tokens, Math.floor(budget.context_window / 4), 1024);
      input = budget.context_window - output - 256;
      if (input <= 0) throw new Error(`Model "${id}" has insufficient context for editor use.`);
    }
    if (values["input-tokens"] !== undefined) {
      const override = Number(values["input-tokens"]);
      if (!Number.isSafeInteger(override) || override < 1 || (!foundry && override > input)) {
        throw new Error(foundry ? "--input-tokens requires a positive integer." : `--input-tokens must be from 1 to ${input} for "${id}".`);
      }
      input = override;
    }
    return { id, input, output, toolCalling: values.tools === true && supportsTools };
  });
  const base = `http://127.0.0.1:${port}/v1`;
  const hasToken = Boolean(process.env.LOCALCODER_API_TOKEN);
  const config = values.continue ? {
    name: "LocalCoder", version: "1.0.0", schema: "v1",
    models: models.map(({ id, input, output, toolCalling }) => ({
      name: id, provider: "openai", model: id, apiBase: base,
      apiKey: hasToken ? "${{ secrets.LOCALCODER_API_TOKEN }}" : "local", roles: ["chat"],
      capabilities: toolCalling ? ["tool_use"] : [], useResponsesApi: false,
      defaultCompletionOptions: { contextLength: input + output, maxTokens: output },
    })),
  } : [{
    name: "LocalCoder", vendor: "customendpoint", apiType: "chat-completions",
    apiKey: hasToken ? "${input:localcoderApiKey}" : "local",
    models: models.map(({ id, input, output, toolCalling }) => ({
      id, name: id, url: base + "/chat/completions", toolCalling, vision: false, streaming: true,
      maxInputTokens: input, maxOutputTokens: output,
    })),
  }];
  console.log(JSON.stringify(config, null, 2));
}
