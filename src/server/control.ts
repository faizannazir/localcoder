import type { IncomingMessage, ServerResponse } from "node:http";
import { checkRequest } from "./security";

export const CONTROL_ROUTE = "/internal/server";
export interface ServerControl {
  token: string;
  shutdown: () => void;
}

export function handleServerControl(req: IncomingMessage, res: ServerResponse, control: ServerControl): void {
  const denied = checkRequest(req, { token: control.token, allowedOrigins: [], extraHosts: [] });
  res.setHeader("Content-Type", "application/json");
  if (denied) {
    res.writeHead(denied.status);
    res.end(JSON.stringify({ error: { message: "Invalid managed-server control request." } }));
    return;
  }
  if (req.method === "POST") res.once("finish", control.shutdown);
  res.end(JSON.stringify({ pid: process.pid }));
}
