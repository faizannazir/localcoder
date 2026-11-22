import { activeBackgroundPort } from "./background-server";

export function parseServerPort(value: string | undefined, allowZero = false): number {
  if (!value || !/^\d+$/.test(value) || Number(value) < (allowZero ? 0 : 1) || Number(value) > 65535) {
    throw new Error(`--port must be an integer from ${allowZero ? 0 : 1} to 65535.`);
  }
  return Number(value);
}

export async function serverPort(value?: string): Promise<number> {
  return value === undefined ? (await activeBackgroundPort()) ?? 8080 : parseServerPort(value);
}

export async function serverRequest<T>(port: number, route: string, body?: object): Promise<T> {
  const token = process.env.LOCALCODER_API_TOKEN;
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers["Content-Type"] = "application/json";
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: body ? "POST" : "GET", body: body && JSON.stringify(body),
      headers, redirect: "error", signal: AbortSignal.timeout(300_000),
    });
  } catch {
    throw new Error(`No response from LocalCoder at 127.0.0.1:${port}. Check the server and port.`);
  }
  const payload = await response.json() as { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? `Server returned HTTP ${response.status}.`);
  return payload as T;
}

export async function runPrompt(args: string[]): Promise<void> {
  const [model, prompt, portFlag, portValue] = args;
  if (!model || !prompt?.trim() || (args.length !== 2 && (args.length !== 4 || portFlag !== "--port"))) {
    throw new Error('Usage: localcoder run <model> "<prompt>" [--port <port>]');
  }
  const port = await serverPort(portValue);
  const response = await serverRequest<{ choices?: { message: { content: string } }[] }>(port, "/v1/chat/completions", {
    model, messages: [{ role: "user", content: prompt }], stream: false,
  });
  const answer = response.choices?.[0]?.message.content;
  if (typeof answer !== "string") throw new Error("The server returned no answer.");
  console.log(answer);
}
