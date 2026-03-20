import type { ResolvedResearchPaths } from "./project-paths.js";
import { runResearchWorker } from "./python-worker.js";

type JsonRecord = Record<string, unknown>;

async function requestJson<TResult>(url: string, init?: RequestInit): Promise<TResult> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`research service request failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as TResult;
}

export async function runResearchRequest<TResult>(
  paths: ResolvedResearchPaths,
  opts: {
    method: "GET" | "POST";
    route: string;
    query?: URLSearchParams;
    body?: JsonRecord;
    fallbackCommand?: string;
    fallbackPayload?: JsonRecord;
  },
): Promise<TResult> {
  if (paths.transport === "fastapi") {
    const base = paths.serviceBaseUrl.replace(/\/$/, "");
    const queryString = opts.query ? `?${opts.query.toString()}` : "";
    return requestJson<TResult>(`${base}${opts.route}${queryString}`, {
      method: opts.method,
      headers: opts.body ? { "Content-Type": "application/json" } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  }

  if (opts.fallbackCommand) {
    return runResearchWorker(paths, opts.fallbackCommand, opts.fallbackPayload ?? {});
  }

  throw new Error("stdio fallback command is required when transport=stdio");
}
