import { Type } from "@sinclair/typebox";
import { jsonResult, readNumberParam, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { asCoordinatorRole, runResearchCoordinatorPass } from "../coordinator-agent.js";
import type { ResolvedResearchPaths } from "../project-paths.js";

const ResearchCoordinatorToolSchema = Type.Object(
  {
    projectId: Type.Optional(Type.String({ description: "Optional project id filter." })),
    ownerAgent: Type.Optional(
      Type.String({ description: "Optional coordinator role: explorer, experiment, writer, reviewer." }),
    ),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    consumeLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { additionalProperties: false },
);

export function createResearchCoordinatorTool(
  api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
) {
  return {
    name: "research_coordinator",
    label: "Research Coordinator",
    description: "Run one or more queued coordinator tasks through the FastAPI research runtime.",
    parameters: ResearchCoordinatorToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const projectId = readStringParam(rawParams, "projectId");
      const ownerAgent = readStringParam(rawParams, "ownerAgent");
      const limit = readNumberParam(rawParams, "limit", { integer: true }) ?? 1;
      const consumeLimit = readNumberParam(rawParams, "consumeLimit", { integer: true }) ?? 20;
      return jsonResult(
        await runResearchCoordinatorPass(api, paths, {
          projectId: projectId ?? undefined,
          ownerAgent: asCoordinatorRole(ownerAgent),
          limit,
          consumeLimit,
        }),
      );
    },
  };
}
