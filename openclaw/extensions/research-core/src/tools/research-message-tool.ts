import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedResearchPaths } from "../project-paths.js";
import { runResearchRequest } from "../research-service.js";

const ResearchMessageToolSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("send"), Type.Literal("list")]),
    projectId: Type.String({ description: "Project id." }),
    fromAgent: Type.Optional(Type.String({ description: "Sender agent for action=send." })),
    toAgent: Type.Optional(Type.String({ description: "Recipient agent." })),
    messageType: Type.Optional(Type.String({ description: "request, feedback, review_note, etc." })),
    priority: Type.Optional(Type.String({ description: "Message priority. Default: normal." })),
    artifactRef: Type.Optional(Type.String({ description: "Optional artifact reference." })),
    content: Type.Optional(Type.String({ description: "Message body for action=send." })),
    status: Type.Optional(Type.String({ description: "Optional status filter for action=list." })),
  },
  { additionalProperties: false },
);

export function createResearchMessageTool(
  _api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
) {
  return {
    name: "research_message",
    label: "Research Message",
    description: "Send structured inter-agent messages or list messages in a project.",
    parameters: ResearchMessageToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readStringParam(rawParams, "action", { required: true });
      const projectId = readStringParam(rawParams, "projectId", { required: true });

      if (action === "send") {
        const fromAgent = readStringParam(rawParams, "fromAgent", { required: true });
        const toAgent = readStringParam(rawParams, "toAgent", { required: true });
        const messageType = readStringParam(rawParams, "messageType", { required: true });
        const content = readStringParam(rawParams, "content", { required: true });
        const priority = readStringParam(rawParams, "priority") ?? "normal";
        const artifactRef = readStringParam(rawParams, "artifactRef");
        const payload = {
          project_id: projectId,
          from_agent: fromAgent,
          to_agent: toAgent,
          message_type: messageType,
          content,
          priority,
          ...(artifactRef ? { artifact_ref: artifactRef } : {}),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/messages",
            body: payload,
            fallbackCommand: "create_message",
            fallbackPayload: payload,
          }),
        );
      }

      if (action === "list") {
        const toAgent = readStringParam(rawParams, "toAgent");
        const status = readStringParam(rawParams, "status");
        const query = new URLSearchParams();
        if (toAgent) query.set("to_agent", toAgent);
        if (status) query.set("status", status);
        return jsonResult(
          await runResearchRequest(paths, {
            method: "GET",
            route: `/v1/projects/${encodeURIComponent(projectId)}/messages`,
            query,
            fallbackCommand: "list_messages",
            fallbackPayload: {
              project_id: projectId,
              ...(toAgent ? { to_agent: toAgent } : {}),
              ...(status ? { status } : {}),
            },
          }),
        );
      }

      throw new Error(`unsupported research_message action: ${action}`);
    },
  };
}
