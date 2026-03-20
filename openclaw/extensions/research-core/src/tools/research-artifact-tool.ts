import { Type } from "@sinclair/typebox";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedResearchPaths } from "../project-paths.js";
import { runResearchRequest } from "../research-service.js";

const ResearchArtifactToolSchema = Type.Object(
  {
    action: Type.Union([Type.Literal("register"), Type.Literal("list")]),
    projectId: Type.String({ description: "Project id." }),
    artifactType: Type.Optional(
      Type.String({ description: "Artifact type for action=register, for example hypotheses." }),
    ),
    owner: Type.Optional(Type.String({ description: "Owner agent for action=register." })),
    path: Type.Optional(Type.String({ description: "Workspace-relative or absolute artifact path." })),
    state: Type.Optional(Type.String({ description: "Artifact state. Default: draft." })),
    version: Type.Optional(Type.Number({ description: "Explicit version override." })),
  },
  { additionalProperties: false },
);

export function createResearchArtifactTool(
  _api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
) {
  return {
    name: "research_artifact",
    label: "Research Artifact",
    description: "Register artifacts into research.db or list artifacts for a project.",
    parameters: ResearchArtifactToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readStringParam(rawParams, "action", { required: true });
      const projectId = readStringParam(rawParams, "projectId", { required: true });

      if (action === "list") {
        return jsonResult(
          await runResearchRequest(paths, {
            method: "GET",
            route: `/v1/projects/${encodeURIComponent(projectId)}/artifacts`,
            fallbackCommand: "list_artifacts",
            fallbackPayload: { project_id: projectId },
          }),
        );
      }

      if (action === "register") {
        const artifactType = readStringParam(rawParams, "artifactType", { required: true });
        const owner = readStringParam(rawParams, "owner", { required: true });
        const artifactPath = readStringParam(rawParams, "path", { required: true });
        const state = readStringParam(rawParams, "state") ?? "draft";
        const version = readNumberParam(rawParams, "version", { integer: true });
        const payload = {
          project_id: projectId,
          artifact_type: artifactType,
          owner,
          path: artifactPath,
          state,
          ...(version !== undefined ? { version } : {}),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/artifacts",
            body: payload,
            fallbackCommand: "register_artifact",
            fallbackPayload: payload,
          }),
        );
      }

      throw new Error(`unsupported research_artifact action: ${action}`);
    },
  };
}
