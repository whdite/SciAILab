import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";
import { pathToFileURL } from "node:url";

const COORDINATOR_ROLES = ["explorer", "experiment", "writer", "reviewer"];

function findRole(sessionKey) {
  for (const role of COORDINATOR_ROLES) {
    if (sessionKey.includes(`:${role}:`)) {
      return role;
    }
  }
  throw new Error(`unable to infer coordinator role from session key: ${sessionKey}`);
}

function buildCoordinatorResponse(role) {
  if (role === "explorer") {
    return {
      artifact_markdown: "# Hypotheses\n\n- H1: agent-backed pipeline works.",
      summary: "Explorer produced initial hypotheses.",
      message: {
        to_agent: "experiment",
        message_type: "handoff",
        content: "Run the minimum verification experiment.",
      },
      event_type: "hypothesis_ready_for_experiment",
    };
  }
  if (role === "experiment") {
    return {
      artifact_markdown: "# Results Summary\n\n- Verified coordinator pass through FastAPI.",
      summary: "Experiment completed validation run.",
      message: {
        to_agent: "writer",
        message_type: "handoff",
        content: "Draft the implementation note.",
      },
      event_type: "experiment_results_ready",
    };
  }
  if (role === "writer") {
    return {
      artifact_markdown: "# Draft\n\nThe coordinator chain is connected to OpenClaw subagents.",
      summary: "Writer prepared the draft artifact.",
      message: {
        to_agent: "reviewer",
        message_type: "review_note",
        content: "Please review the MVP validation draft.",
      },
      event_type: "review_requested",
    };
  }
  throw new Error("reviewer response requires explicit review step");
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

function makeApiMock() {
  const transcripts = new Map();
  let runCounter = 0;
  let reviewerDecisionCount = 0;

  return {
    logger: {
      info() {},
      warn() {},
    },
    runtime: {
      subagent: {
        async run({ sessionKey }) {
          const role = findRole(sessionKey);
          let payload = role === "reviewer" ? null : buildCoordinatorResponse(role);
          if (role === "reviewer") {
            reviewerDecisionCount += 1;
            if (reviewerDecisionCount === 1) {
              payload = {
                artifact_markdown: "# Review Report\n\nNeed one ablation pass before approval.",
                summary: "Reviewer requested ablation.",
                message: {
                  to_agent: "experiment",
                  message_type: "review_note",
                  content: "Run one ablation pass to validate the main claim.",
                },
                event_type: "review_requires_ablation",
              };
            } else if (reviewerDecisionCount === 2) {
              payload = {
                artifact_markdown: "# Review Report\n\nNeed stronger evidence for the current claims.",
                summary: "Reviewer requested stronger evidence.",
                message: {
                  to_agent: "experiment",
                  message_type: "review_note",
                  content: "Gather additional supporting evidence for the draft.",
                },
                event_type: "review_requires_evidence",
              };
            } else if (reviewerDecisionCount === 3) {
              payload = {
                artifact_markdown: "# Review Report\n\nEvidence is sufficient, but the draft needs revision.",
                summary: "Reviewer requested a writing revision.",
                message: {
                  to_agent: "writer",
                  message_type: "review_note",
                  content: "Revise the draft to address reviewer comments.",
                },
                event_type: "review_requires_revision",
              };
            } else {
              payload = {
                artifact_markdown: "# Review Report\n\nApproved for the current MVP milestone.",
                summary: "Reviewer accepted the draft.",
                message: {
                  to_agent: "writer",
                  message_type: "approval",
                  content: "The draft is approved for the current milestone.",
                },
                event_type: "review_approved",
              };
            }
          }
          if (!payload) {
            throw new Error(`missing mock payload for role: ${role}`);
          }
          transcripts.set(sessionKey, {
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(payload),
                  },
                ],
              },
            ],
          });
          runCounter += 1;
          return { runId: `run_${String(runCounter)}` };
        },
        async waitForRun() {
          return { status: "ok" };
        },
        async getSessionMessages({ sessionKey }) {
          return transcripts.get(sessionKey) ?? { messages: [] };
        },
        async deleteSession({ sessionKey }) {
          transcripts.delete(sessionKey);
        },
      },
    },
  };
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sciailab-agent-verify-"));
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

    const project = await requestJson(baseUrl, "/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "SciAILab Agent Coordinator Verification",
        goal: "Verify the OpenClaw agent-backed coordinator path.",
        project_id: "agent-coordinator-check",
      }),
    });
    const projectId = project.project.project_id;

    const { runResearchCoordinatorPass } = await import(
      pathToFileURL(path.resolve("openclaw/extensions/research-core/src/coordinator-agent.ts")).href
    );

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
      coordinatorAutoRun: false,
      coordinatorPollMs: 3000,
      coordinatorBatchSize: 1,
      coordinatorRunTimeoutMs: 30000,
      coordinatorSessionPrefix: "agent:main:subagent:research-core",
      coordinatorDeleteSession: true,
    };

    const api = makeApiMock();
    const runs = [];
    for (let index = 0; index < 16; index += 1) {
      const result = await runResearchCoordinatorPass(api, paths, {
        projectId,
        limit: 1,
        consumeLimit: 20,
      });
      runs.push(result);
      if (result.count === 0) {
        break;
      }
    }

    const tasks = await requestJson(baseUrl, `/v1/projects/${projectId}/tasks`);
    const artifacts = await requestJson(baseUrl, `/v1/projects/${projectId}/artifacts`);
    const packages = await requestJson(baseUrl, `/v1/projects/${projectId}/packages`);
    const messages = await requestJson(baseUrl, `/v1/projects/${projectId}/messages`);
    const events = await requestJson(baseUrl, `/v1/projects/${projectId}/events`);
    const agentStates = await requestJson(baseUrl, `/v1/projects/${projectId}/state/agents`);

    const taskStatuses = Object.fromEntries(tasks.tasks.map((task) => [task.owner_agent, task.status]));
    const artifactTypes = [...new Set(artifacts.artifacts.map((artifact) => artifact.artifact_type))].sort();
    const eventTypes = events.events.map((event) => event.event_type);
    const packageTypes = [...new Set(packages.packages.map((item) => item.package_type))].sort();
    const messageEdges = new Set(
      messages.messages.map((item) => `${item.from_agent}->${item.to_agent}:${item.message_type}`),
    );

    assert.deepEqual(taskStatuses, {
      explorer: "done",
      experiment: "done",
      writer: "done",
      reviewer: "done",
    });
    assert.deepEqual(artifactTypes, ["draft", "hypotheses", "results_summary", "review_report"]);
    assert.ok(packages.packages.length >= 8);
    assert.ok(packageTypes.includes("research_package"));
    assert.ok(packageTypes.includes("experiment_bundle"));
    assert.ok(packageTypes.includes("writing_input_package"));
    assert.ok(messageEdges.has("explorer->experiment:handoff"));
    assert.ok(messageEdges.has("experiment->writer:handoff"));
    assert.ok(messageEdges.has("writer->reviewer:review_note"));
    assert.ok(messageEdges.has("reviewer->experiment:review_note"));
    assert.ok(messageEdges.has("reviewer->writer:review_note"));
    assert.ok(messageEdges.has("reviewer->writer:approval"));
    assert.ok(eventTypes.includes("hypothesis_ready_for_experiment"));
    assert.ok(eventTypes.includes("experiment_results_ready"));
    assert.ok(eventTypes.includes("review_requested"));
    assert.ok(eventTypes.includes("review_requires_ablation"));
    assert.ok(eventTypes.includes("review_requires_evidence"));
    assert.ok(eventTypes.includes("review_requires_revision"));
    assert.ok(eventTypes.includes("review_approved"));
    assert.deepEqual(
      Object.fromEntries(agentStates.agent_states.map((item) => [item.agent_id, item.state])),
      {
        explorer: "idle",
        experiment: "idle",
        writer: "done",
        reviewer: "idle",
      },
    );

    console.log(
      JSON.stringify(
        {
          project_id: projectId,
          health: health.status,
          coordinator_passes: runs.map((item) => item.count),
          task_statuses: taskStatuses,
          artifact_types: artifactTypes,
          package_types: packageTypes,
          package_count: packages.packages.length,
          message_count: messages.messages.length,
          events: eventTypes,
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
