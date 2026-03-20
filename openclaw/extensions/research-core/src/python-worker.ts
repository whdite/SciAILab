import path from "node:path";
import { spawn } from "node:child_process";
import type { ResolvedResearchPaths } from "./project-paths.js";

type WorkerEnvelope<TPayload extends Record<string, unknown>> = {
  command: string;
  db_path: string;
  workspace_root: string;
  payload: TPayload;
};

type WorkerResponse<TResult> =
  | { status: "ok"; result: TResult }
  | { status: "error"; error: string; error_type?: string };

export async function runResearchWorker<TResult, TPayload extends Record<string, unknown>>(
  paths: ResolvedResearchPaths,
  command: string,
  payload: TPayload,
): Promise<TResult> {
  if (paths.transport === "fastapi") {
    throw new Error(
      "runResearchWorker is disabled for transport=fastapi; use the FastAPI service client instead",
    );
  }
  const request: WorkerEnvelope<TPayload> = {
    command,
    db_path: paths.dbPath,
    workspace_root: paths.workspaceRoot,
    payload,
  };

  const env = {
    ...process.env,
    PYTHONPATH: [paths.pythonModuleRoot, process.env.PYTHONPATH]
      .filter((entry): entry is string => Boolean(entry && entry.trim()))
      .join(path.delimiter),
  };

  return new Promise<TResult>((resolve, reject) => {
    const child = spawn(paths.pythonBinary, ["-m", "research_runtime.cli.worker"], {
      cwd: paths.projectRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(error);
    });
    child.on("close", (_code) => {
      if (!stdout.trim()) {
        reject(new Error(stderr.trim() || "research worker returned no output"));
        return;
      }

      let parsed: WorkerResponse<TResult>;
      try {
        parsed = JSON.parse(stdout) as WorkerResponse<TResult>;
      } catch (error) {
        reject(
          new Error(
            `failed to parse research worker response: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        return;
      }

      if (parsed.status === "error") {
        const detail = stderr.trim() ? ` (${stderr.trim()})` : "";
        reject(new Error(`${parsed.error}${detail}`));
        return;
      }

      resolve(parsed.result);
    });

    child.stdin.write(JSON.stringify(request));
    child.stdin.end();
  });
}
