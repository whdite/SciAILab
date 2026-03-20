import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedResearchPaths } from "../project-paths.js";
import { runResearchRequest } from "../research-service.js";

const ResearchTaskToolSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("create"), Type.Literal("list"), Type.Literal("update_status")]),
    projectId: Type.Optional(Type.String({ description: "Project id." })),
    title: Type.Optional(Type.String({ description: "Task title for action=create." })),
    scope: Type.Optional(Type.String({ description: "experiment, writer, reviewer, etc." })),
    ownerAgent: Type.Optional(Type.String({ description: "Task owner agent." })),
    dependency: Type.Optional(Type.String({ description: "Optional dependency reference." })),
    acceptance: Type.Optional(Type.String({ description: "Acceptance criteria." })),
    status: Type.Optional(Type.String({ description: "Task status or filter." })),
    taskId: Type.Optional(Type.String({ description: "Task id for action=update_status." })),
    source: Type.Optional(Type.String({ description: "Event source when updating status with downstream emission." })),
    eventType: Type.Optional(Type.String({ description: "Optional event emitted after task status update." })),
    eventPayload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export function createResearchTaskTool(
  _api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
) {
  return {
    name: "research_task",
    label: "Research Task",
    description: "Create, list, and update project tasks in the research task queue.",
    parameters: ResearchTaskToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readStringParam(rawParams, "action", { required: true });
      if (action === "create") {
        const projectId = readStringParam(rawParams, "projectId", { required: true });
        const title = readStringParam(rawParams, "title", { required: true });
        const scope = readStringParam(rawParams, "scope", { required: true });
        const ownerAgent = readStringParam(rawParams, "ownerAgent", { required: true });
        const dependency = readStringParam(rawParams, "dependency");
        const acceptance = readStringParam(rawParams, "acceptance");
        const status = readStringParam(rawParams, "status") ?? "todo";
        const payload = {
          project_id: projectId,
          title,
          scope,
          owner_agent: ownerAgent,
          ...(dependency ? { dependency } : {}),
          ...(acceptance ? { acceptance } : {}),
          status,
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/tasks",
            body: payload,
            fallbackCommand: "create_task",
            fallbackPayload: payload,
          }),
        );
      }

      if (action === "list") {
        const projectId = readStringParam(rawParams, "projectId", { required: true });
        const ownerAgent = readStringParam(rawParams, "ownerAgent");
        const status = readStringParam(rawParams, "status");
        const query = new URLSearchParams();
        if (ownerAgent) query.set("owner_agent", ownerAgent);
        if (status) query.set("status", status);
        const payload = {
          project_id: projectId,
          ...(ownerAgent ? { owner_agent: ownerAgent } : {}),
          ...(status ? { status } : {}),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "GET",
            route: `/v1/projects/${encodeURIComponent(projectId)}/tasks`,
            query,
            fallbackCommand: "list_tasks",
            fallbackPayload: payload,
          }),
        );
      }

      if (action === "update_status") {
        const taskId = readStringParam(rawParams, "taskId", { required: true });
        const status = readStringParam(rawParams, "status", { required: true });
        const source = readStringParam(rawParams, "source");
        const eventType = readStringParam(rawParams, "eventType");
        const eventPayload =
          rawParams.eventPayload &&
          typeof rawParams.eventPayload === "object" &&
          !Array.isArray(rawParams.eventPayload)
            ? (rawParams.eventPayload as Record<string, unknown>)
            : undefined;
        const payload = {
          task_id: taskId,
          status,
          ...(source ? { source } : {}),
          ...(eventType ? { event_type: eventType } : {}),
          ...(eventPayload ? { event_payload: eventPayload } : {}),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/tasks/status",
            body: payload,
            fallbackCommand: "update_task_status",
            fallbackPayload: payload,
          }),
        );
      }

      throw new Error(`unsupported research_task action: ${action}`);
    },
  };
}
