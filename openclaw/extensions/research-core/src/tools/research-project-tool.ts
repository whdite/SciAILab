import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedResearchPaths } from "../project-paths.js";
import { runResearchRequest } from "../research-service.js";

const ResearchProjectToolSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("init_db"),
      Type.Literal("create"),
      Type.Literal("status"),
    ]),
    name: Type.Optional(Type.String({ description: "Project name when action=create." })),
    goal: Type.Optional(Type.String({ description: "Optional project goal when action=create." })),
    projectId: Type.Optional(
      Type.String({
        description: "Project id for action=status, or explicit id override for action=create.",
      }),
    ),
    ownerAgent: Type.Optional(
      Type.String({ description: "Owner agent for action=create. Default: control-plane." }),
    ),
  },
  { additionalProperties: false },
);

export function createResearchProjectTool(
  _api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
) {
  return {
    name: "research_project",
    label: "Research Project",
    description: "Create research projects, initialize research.db, and inspect project status.",
    parameters: ResearchProjectToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readStringParam(rawParams, "action", { required: true });

      if (action === "init_db") {
        return jsonResult(await runResearchRequest(paths, {
          method: "GET",
          route: "/health",
          fallbackCommand: "init_db",
          fallbackPayload: {},
        }));
      }

      if (action === "create") {
        const name = readStringParam(rawParams, "name", { required: true });
        const goal = readStringParam(rawParams, "goal") ?? "";
        const ownerAgent = readStringParam(rawParams, "ownerAgent") ?? "control-plane";
        const projectId = readStringParam(rawParams, "projectId");
        const payload = {
          name,
          goal,
          owner_agent: ownerAgent,
          ...(projectId ? { project_id: projectId } : {}),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/projects",
            body: payload,
            fallbackCommand: "create_project",
            fallbackPayload: payload,
          }),
        );
      }

      if (action === "status") {
        const projectId = readStringParam(rawParams, "projectId", { required: true });
        return jsonResult(
          await runResearchRequest(paths, {
            method: "GET",
            route: `/v1/projects/${encodeURIComponent(projectId)}`,
            fallbackCommand: "get_project_status",
            fallbackPayload: { project_id: projectId },
          }),
        );
      }

      throw new Error(`unsupported research_project action: ${action}`);
    },
  };
}
