import type { ServerResponse } from "http";
import type { AppContext } from "../context";
import { FOUNDRY_MODEL_PREFIX } from "../../inference/foundry-local";
import { isDownloaded } from "../../router/registry";
import { isRejection } from "../../types/index";

export async function handleModels(_body: unknown, res: ServerResponse, ctx: AppContext, signal?: AbortSignal): Promise<void> {
  const residentIds = new Set(ctx.modelManager.resident().map((m) => m.model_id));

  const models = ctx.registry.map((entry) => ({
    ...entry,
    id: entry.model_id,
    object: "model",
    created: 0,
    owned_by: "local",
    resident: residentIds.has(entry.model_id),
    downloaded: isDownloaded(entry, ctx.baseDir),
  }));

  let foundry: object[] = [];
  let foundry_error: string | undefined;
  if (ctx.foundry) {
    try {
      foundry = (await ctx.foundry.models(signal)).map((name) => {
        const id = FOUNDRY_MODEL_PREFIX + name;
        return { id, model_id: id, object: "model", created: 0, owned_by: "foundry-local", downloaded: true };
      });
    } catch {
      foundry_error = "Foundry Local model discovery failed. Check the configured endpoint.";
    }
  }
  if (signal?.aborted) return;
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: [...models, ...foundry], foundry_error }));
}

export async function handleModelResidency(body: unknown, res: ServerResponse, ctx: AppContext, operation: "load" | "unload"): Promise<void> {
  const model = (body as { model?: unknown } | null)?.model;
  const reply = (status: number, payload: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (typeof model !== "string" || !model.trim()) {
    reply(400, { error: { message: "Provide a model ID." } });
    return;
  }
  const entry = ctx.registry.find((candidate) => candidate.model_id === model);
  if (!entry) {
    reply(404, { error: { message: `Model "${model}" is not installed on this server.` } });
    return;
  }
  if (operation === "unload") {
    await ctx.modelManager.unload(model);
    reply(200, { model, resident: false });
    return;
  }
  const policy = ctx.policyEngine.derive(await ctx.profiler.sample());
  const decision = ctx.router.route("chat_simple", policy, [entry]);
  if (isRejection(decision)) {
    reply(503, { error: { message: `Model "${model}" does not fit the current memory budget.`, attempted: decision.attempted } });
    return;
  }
  await ctx.modelManager.ensure(decision, policy, 5);
  reply(200, { model, resident: true });
}
