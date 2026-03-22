import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { pathToFileURL } from "node:url";

const ROLE_DELAYS = {
  explorer: 160,
  experiment: 30,
  writer: 30,
  reviewer: 20,
};

function findRole(sessionKey) {
  for (const role of ["explorer", "experiment", "writer", "reviewer"]) {
    if (sessionKey.includes(`:${role}:`)) {
      return role;
    }
  }
  throw new Error(`unable to infer coordinator role from session key: ${sessionKey}`);
}

function buildCoordinatorResponse(role) {
  if (role === "explorer") {
    return {
      artifact_markdown: "# Hypotheses\n\n- Parallel explorer worker verified.",
      summary: "Explorer prepared the hypothesis package.",
      message: {
        to_agent: "experiment",
        message_type: "handoff",
        content: "Run the experiment stage.",
      },
      event_type: "hypothesis_ready_for_experiment",
    };
  }
  if (role === "experiment") {
    return {
      artifact_markdown: "# Results Summary\n\n- Experiment worker verified.",
      summary: "Experiment completed.",
      message: {
        to_agent: "writer",
        message_type: "handoff",
        content: "Prepare the draft.",
      },
      event_type: "experiment_results_ready",
    };
  }
  if (role === "writer") {
    return {
      artifact_markdown: "# Draft\n\nThe worker-pool scheduler routed the draft stage correctly.",
      summary: "Writer completed the draft.",
      message: {
        to_agent: "reviewer",
        message_type: "review_note",
        content: "Please review the draft.",
      },
      event_type: "review_requested",
    };
  }
  return {
    artifact_markdown: "# Review Report\n\nApproved for the worker-pool verification path.",
    summary: "Reviewer approved the draft.",
    message: {
      to_agent: "writer",
      message_type: "approval",
      content: "Approved for the current verification pass.",
    },
    event_type: "review_approved",
  };
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) {
        return await response.json();
      }
    } catch {}
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`FastAPI service did not become healthy within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function requestJson(baseUrl, route, init = undefined) {
  const response = await fetch(`${baseUrl}${route}`, init);
  if (!response.ok) {
    throw new Error(`request failed for ${route}: ${response.status} ${response.statusText}`);
  }
  return await response.json();
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate free port"));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function createApiMock() {
  const transcripts = new Map();
  const runs = new Map();
  let runCounter = 0;
  const activeByRole = new Map();
  const maxActiveByRole = new Map();
  const routeUsage = new Map();

  return {
    metrics: {
      activeByRole,
      maxActiveByRole,
      routeUsage,
    },
    logger: {
      info() {},
      warn() {},
    },
    runtime: {
      subagent: {
        async run({ sessionKey, provider, model, authProfile }) {
          const role = findRole(sessionKey);
          const active = (activeByRole.get(role) ?? 0) + 1;
          activeByRole.set(role, active);
          maxActiveByRole.set(role, Math.max(active, maxActiveByRole.get(role) ?? 0));
          const usage = routeUsage.get(role) ?? new Set();
          usage.add(`${provider ?? ""}|${model ?? ""}|${authProfile ?? ""}`);
          routeUsage.set(role, usage);
          runCounter += 1;
          const runId = `run_${String(runCounter)}`;
          runs.set(runId, role);
          transcripts.set(sessionKey, {
            role,
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(buildCoordinatorResponse(role)),
                  },
                ],
              },
            ],
          });
          return { runId };
        },
        async waitForRun({ runId }) {
          const role = runs.get(runId) ?? "reviewer";
          await new Promise((resolve) => setTimeout(resolve, ROLE_DELAYS[role] ?? 20));
          activeByRole.set(role, Math.max(0, (activeByRole.get(role) ?? 1) - 1));
          return { status: "ok" };
        },
        async getSessionMessages({ sessionKey }) {
          const transcript = transcripts.get(sessionKey);
          return { messages: transcript?.messages ?? [] };
        },
        async deleteSession({ sessionKey }) {
          transcripts.delete(sessionKey);
        },
      },
    },
  };
}

async function waitForProjectCompletion(baseUrl, projectId, timeoutMs = 20000) {
  const startedAt = Date.now();
  for (;;) {
    const tasks = await requestJson(baseUrl, `/v1/projects/${projectId}/tasks`);
    const statuses = Object.fromEntries(tasks.tasks.map((item) => [item.owner_agent, item.status]));
    if (
      statuses.explorer === "done" &&
      statuses.experiment === "done" &&
      statuses.writer === "done" &&
      statuses.reviewer === "done"
    ) {
      return statuses;
    }
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`project ${projectId} did not complete within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sciailab-service-pool-"));
  const dbPath = path.join(tempRoot, "research.db");
  const workspaceRoot = path.join(tempRoot, "workspace");
  await fs.mkdir(workspaceRoot, { recursive: true });

  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const server = spawn(
    "python",
    ["-m", "uvicorn", "research_runtime.api.app:app", "--host", "127.0.0.1", "--port", String(port), "--log-level", "error"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SCIAILAB_DB_PATH: dbPath,
        SCIAILAB_WORKSPACE_ROOT: workspaceRoot,
        SCIAILAB_FASTAPI_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  server.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const health = await waitForHealth(baseUrl);
    assert.equal(health.status, "ok");

    await requestJson(baseUrl, "/v1/control/agent-routing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routes: [
          { role: "explorer", provider: "provider-explorer", model: "model-explorer", auth_profile: "profile-explorer", max_concurrency: 2, active: true },
          { role: "experiment", provider: "provider-experiment", model: "model-experiment", auth_profile: "profile-experiment", max_concurrency: 1, active: true },
          { role: "writer", provider: "provider-writer", model: "model-writer", auth_profile: "profile-writer", max_concurrency: 1, active: true },
          { role: "reviewer", provider: "provider-reviewer", model: "model-reviewer", auth_profile: "profile-reviewer", max_concurrency: 1, active: true },
        ],
      }),
    });

    const projectA = await requestJson(baseUrl, "/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "SciAILab Service Worker Pool A",
        goal: "Verify OpenClaw role worker pool scheduling.",
        project_id: "service-pool-a",
      }),
    });
    const projectB = await requestJson(baseUrl, "/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "SciAILab Service Worker Pool B",
        goal: "Verify explorer concurrency across projects.",
        project_id: "service-pool-b",
      }),
    });

    const { createResearchCoordinatorService } = await import(
      pathToFileURL(path.resolve("openclaw/extensions/research-core/src/coordinator-agent.ts")).href
    );
    const api = createApiMock();
    const paths = {
      projectRoot: path.resolve("."),
      pythonBinary: "python",
      transport: "fastapi",
      serviceBaseUrl: baseUrl,
      pythonModuleRoot: path.resolve("python"),
      dbPath,
      workspaceRoot,
      enabled: true,
      coordinatorExecution: "agent",
      coordinatorAutoRun: true,
      coordinatorPollMs: 50,
      coordinatorBatchSize: 1,
      coordinatorRunTimeoutMs: 30000,
      coordinatorSessionPrefix: "agent:main:subagent:research-core",
      coordinatorDeleteSession: true,
    };

    const service = createResearchCoordinatorService(api, paths);
    await service.start();

    const statusesA = await waitForProjectCompletion(baseUrl, projectA.project.project_id);
    const statusesB = await waitForProjectCompletion(baseUrl, projectB.project.project_id);

    await service.stop();

    assert.deepEqual(statusesA, {
      explorer: "done",
      experiment: "done",
      writer: "done",
      reviewer: "done",
    });
    assert.deepEqual(statusesB, {
      explorer: "done",
      experiment: "done",
      writer: "done",
      reviewer: "done",
    });
    assert.ok((api.metrics.maxActiveByRole.get("explorer") ?? 0) >= 2);
    assert.ok(
      api.metrics.routeUsage.get("explorer")?.has("provider-explorer|model-explorer|profile-explorer"),
    );
    assert.ok(
      api.metrics.routeUsage.get("experiment")?.has(
        "provider-experiment|model-experiment|profile-experiment",
      ),
    );
    assert.ok(
      api.metrics.routeUsage.get("writer")?.has("provider-writer|model-writer|profile-writer"),
    );
    assert.ok(
      api.metrics.routeUsage.get("reviewer")?.has(
        "provider-reviewer|model-reviewer|profile-reviewer",
      ),
    );

    console.log(
      JSON.stringify(
        {
          health: health.status,
          projects: [projectA.project.project_id, projectB.project.project_id],
          max_concurrency_observed: Object.fromEntries(api.metrics.maxActiveByRole.entries()),
          route_usage: Object.fromEntries(
            Array.from(api.metrics.routeUsage.entries()).map(([role, usage]) => [role, Array.from(usage.values())]),
          ),
        },
        null,
        2,
      ),
    );
  } finally {
    server.kill("SIGTERM");
    await new Promise((resolve) => {
      server.once("exit", resolve);
      setTimeout(resolve, 5000);
    });
    if (server.exitCode !== 0 && server.exitCode !== null && stderr.trim()) {
      process.stderr.write(stderr);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
