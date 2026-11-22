import type { ServerResponse } from "http";
import type { AppContext } from "../context";
import { isDownloaded } from "../../router/registry";

export async function handleModels(_body: unknown, res: ServerResponse, ctx: AppContext): Promise<void> {
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

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ object: "list", data: models }));
}
