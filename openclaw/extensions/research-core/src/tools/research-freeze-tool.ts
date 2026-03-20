import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedResearchPaths } from "../project-paths.js";
import { runResearchRequest } from "../research-service.js";

const ResearchFreezeToolSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("freeze"), Type.Literal("list")]),
    projectId: Type.String({ description: "Project id." }),
    packageType: Type.Optional(
      Type.String({
        description: "Package type such as research_package, experiment_bundle, or writing_input_package.",
      }),
    ),
    state: Type.Optional(Type.String({ description: "Frozen package state. Default: frozen." })),
    createdFrom: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);

export function createResearchFreezeTool(
  _api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
) {
  return {
    name: "research_freeze",
    label: "Research Freeze",
    description: "Freeze package manifests for downstream stages or inspect existing frozen packages.",
    parameters: ResearchFreezeToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readStringParam(rawParams, "action", { required: true });
      const projectId = readStringParam(rawParams, "projectId", { required: true });

      if (action === "freeze") {
        const packageType = readStringParam(rawParams, "packageType", { required: true });
        const state = readStringParam(rawParams, "state") ?? "frozen";
        const createdFrom = Array.isArray(rawParams.createdFrom)
          ? rawParams.createdFrom.filter((item): item is string => typeof item === "string")
          : undefined;
        const payload = {
          project_id: projectId,
          package_type: packageType,
          state,
          ...(createdFrom ? { created_from: createdFrom } : {}),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/packages/freeze",
            body: payload,
            fallbackCommand: "freeze_package",
            fallbackPayload: payload,
          }),
        );
      }

      if (action === "list") {
        const packageType = readStringParam(rawParams, "packageType");
        const query = new URLSearchParams();
        if (packageType) query.set("package_type", packageType);
        return jsonResult(
          await runResearchRequest(paths, {
            method: "GET",
            route: `/v1/projects/${encodeURIComponent(projectId)}/packages`,
            query,
            fallbackCommand: "list_packages",
            fallbackPayload: {
              project_id: projectId,
              ...(packageType ? { package_type: packageType } : {}),
            },
          }),
        );
      }

      throw new Error(`unsupported research_freeze action: ${action}`);
    },
  };
}
