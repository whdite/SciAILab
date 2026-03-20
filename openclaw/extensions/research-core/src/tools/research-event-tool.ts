import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedResearchPaths } from "../project-paths.js";
import { runResearchRequest } from "../research-service.js";

const ResearchEventToolSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("emit"), Type.Literal("list"), Type.Literal("consume")]),
    projectId: Type.String({ description: "Project id." }),
    eventType: Type.Optional(Type.String({ description: "Event type for action=emit or filter." })),
    source: Type.Optional(Type.String({ description: "Event source for action=emit." })),
    status: Type.Optional(Type.String({ description: "Optional status filter for action=list." })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    payload: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);

export function createResearchEventTool(
  _api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
) {
  return {
    name: "research_event",
    label: "Research Event",
    description: "Emit project events or inspect the event bus for a project.",
    parameters: ResearchEventToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readStringParam(rawParams, "action", { required: true });
      const projectId = readStringParam(rawParams, "projectId", { required: true });

      if (action === "emit") {
        const eventType = readStringParam(rawParams, "eventType", { required: true });
        const source = readStringParam(rawParams, "source", { required: true });
        const payload =
          rawParams.payload && typeof rawParams.payload === "object" && !Array.isArray(rawParams.payload)
            ? (rawParams.payload as Record<string, unknown>)
            : undefined;
        const requestPayload = {
          project_id: projectId,
          event_type: eventType,
          source,
          ...(payload ? { payload } : {}),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/events",
            body: requestPayload,
            fallbackCommand: "emit_event",
            fallbackPayload: requestPayload,
          }),
        );
      }

      if (action === "list") {
        const status = readStringParam(rawParams, "status");
        const eventType = readStringParam(rawParams, "eventType");
        const query = new URLSearchParams();
        if (status) query.set("status", status);
        if (eventType) query.set("event_type", eventType);
        return jsonResult(
          await runResearchRequest(paths, {
            method: "GET",
            route: `/v1/projects/${encodeURIComponent(projectId)}/events`,
            query,
            fallbackCommand: "list_events",
            fallbackPayload: {
              project_id: projectId,
              ...(status ? { status } : {}),
              ...(eventType ? { event_type: eventType } : {}),
            },
          }),
        );
      }

      if (action === "consume") {
        const limit = typeof rawParams.limit === "number" ? rawParams.limit : 20;
        const payload = { project_id: projectId, limit };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/events/consume",
            body: payload,
            fallbackCommand: "consume_events",
            fallbackPayload: payload,
          }),
        );
      }

      throw new Error(`unsupported research_event action: ${action}`);
    },
  };
}
