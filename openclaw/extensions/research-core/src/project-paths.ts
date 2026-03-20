import path from "node:path";

export type ResearchPluginConfig = {
  enabled?: boolean;
  pythonBinary?: string;
  transport?: string;
  serviceBaseUrl?: string;
  dbPath?: string;
  workspaceRoot?: string;
  coordinatorExecution?: string;
  coordinatorAutoRun?: boolean;
  coordinatorPollMs?: number;
  coordinatorBatchSize?: number;
  coordinatorRunTimeoutMs?: number;
  coordinatorSessionPrefix?: string;
  coordinatorDeleteSession?: boolean;
  coordinatorProvider?: string;
  coordinatorModel?: string;
};

export type ResolvedResearchPaths = {
  projectRoot: string;
  pythonBinary: string;
  transport: "fastapi" | "stdio";
  serviceBaseUrl: string;
  pythonModuleRoot: string;
  dbPath: string;
  workspaceRoot: string;
  enabled: boolean;
  coordinatorExecution: "agent" | "python";
  coordinatorAutoRun: boolean;
  coordinatorPollMs: number;
  coordinatorBatchSize: number;
  coordinatorRunTimeoutMs: number;
  coordinatorSessionPrefix: string;
  coordinatorDeleteSession: boolean;
  coordinatorProvider?: string;
  coordinatorModel?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolvePathFromRoot(projectRoot: string, value: string | undefined, fallback: string): string {
  const raw = value?.trim();
  if (!raw) {
    return path.join(projectRoot, fallback);
  }
  return path.isAbsolute(raw) ? raw : path.join(projectRoot, raw);
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function getSciAILabProjectRoot(): string {
  return path.resolve(import.meta.dirname, "../../../../");
}

export function resolveResearchPluginConfig(raw: unknown): ResolvedResearchPaths {
  const parsed = isRecord(raw) ? raw : {};
  const projectRoot = getSciAILabProjectRoot();
  const pythonBinary =
    (typeof parsed.pythonBinary === "string" && parsed.pythonBinary.trim()) ||
    process.env.SCIAILAB_PYTHON_BIN ||
    "python";
  const transport =
    parsed.transport === "stdio" || process.env.SCIAILAB_RESEARCH_TRANSPORT === "stdio"
      ? "stdio"
      : "fastapi";
  const serviceBaseUrl =
    (typeof parsed.serviceBaseUrl === "string" && parsed.serviceBaseUrl.trim()) ||
    process.env.SCIAILAB_FASTAPI_URL ||
    "http://127.0.0.1:8765";
  const coordinatorExecution =
    parsed.coordinatorExecution === "python" ? "python" : "agent";
  const coordinatorPollMs = Math.max(1000, asOptionalNumber(parsed.coordinatorPollMs) ?? 3000);
  const coordinatorBatchSize = Math.max(1, asOptionalNumber(parsed.coordinatorBatchSize) ?? 1);
  const coordinatorRunTimeoutMs = Math.max(
    30_000,
    asOptionalNumber(parsed.coordinatorRunTimeoutMs) ?? 180_000,
  );
  const coordinatorSessionPrefix =
    (typeof parsed.coordinatorSessionPrefix === "string" &&
      parsed.coordinatorSessionPrefix.trim()) ||
    "agent:main:subagent:research-core";

  return {
    projectRoot,
    pythonBinary,
    transport,
    serviceBaseUrl,
    pythonModuleRoot: path.join(projectRoot, "python"),
    dbPath: resolvePathFromRoot(projectRoot, asOptionalString(parsed.dbPath), "data/research.db"),
    workspaceRoot: resolvePathFromRoot(
      projectRoot,
      asOptionalString(parsed.workspaceRoot),
      "workspace/projects",
    ),
    enabled: parsed.enabled !== false,
    coordinatorExecution,
    coordinatorAutoRun:
      coordinatorExecution === "agent" && asOptionalBoolean(parsed.coordinatorAutoRun) !== false,
    coordinatorPollMs,
    coordinatorBatchSize,
    coordinatorRunTimeoutMs,
    coordinatorSessionPrefix,
    coordinatorDeleteSession: asOptionalBoolean(parsed.coordinatorDeleteSession) !== false,
    coordinatorProvider: asOptionalString(parsed.coordinatorProvider),
    coordinatorModel: asOptionalString(parsed.coordinatorModel),
  };
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
