import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedResearchPaths } from "../project-paths.js";
import { runResearchRequest } from "../research-service.js";

const ResearchStateToolSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("artifact_transition"),
      Type.Literal("agent_set"),
      Type.Literal("agent_list"),
    ]),
    artifactId: Type.Optional(Type.String()),
    nextState: Type.Optional(Type.String()),
    projectId: Type.Optional(Type.String()),
    agentId: Type.Optional(Type.String()),
    state: Type.Optional(Type.String()),
    currentTaskId: Type.Optional(Type.String()),
    lastError: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export function createResearchStateTool(
  _api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
) {
  return {
    name: "research_state",
    label: "Research State",
    description: "Apply artifact state transitions and update agent states through the research state machine.",
    parameters: ResearchStateToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readStringParam(rawParams, "action", { required: true });
      if (action === "artifact_transition") {
        const artifactId = readStringParam(rawParams, "artifactId", { required: true });
        const nextState = readStringParam(rawParams, "nextState", { required: true });
        const payload = { artifact_id: artifactId, next_state: nextState };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/state/artifact",
            body: payload,
            fallbackCommand: "transition_artifact_state",
            fallbackPayload: payload,
          }),
        );
      }

      if (action === "agent_set") {
        const projectId = readStringParam(rawParams, "projectId", { required: true });
        const agentId = readStringParam(rawParams, "agentId", { required: true });
        const state = readStringParam(rawParams, "state", { required: true });
        const currentTaskId = readStringParam(rawParams, "currentTaskId");
        const lastError = readStringParam(rawParams, "lastError");
        const payload = {
          project_id: projectId,
          agent_id: agentId,
          state,
          ...(currentTaskId ? { current_task_id: currentTaskId } : {}),
          ...(lastError ? { last_error: lastError } : {}),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/state/agent",
            body: payload,
            fallbackCommand: "set_agent_state",
            fallbackPayload: payload,
          }),
        );
      }

      if (action === "agent_list") {
        const projectId = readStringParam(rawParams, "projectId", { required: true });
        const agentId = readStringParam(rawParams, "agentId");
        const state = readStringParam(rawParams, "state");
        const query = new URLSearchParams();
        if (agentId) query.set("agent_id", agentId);
        if (state) query.set("state", state);
        return jsonResult(
          await runResearchRequest(paths, {
            method: "GET",
            route: `/v1/projects/${encodeURIComponent(projectId)}/state/agents`,
            query,
            fallbackCommand: "list_agent_states",
            fallbackPayload: {
              project_id: projectId,
              ...(agentId ? { agent_id: agentId } : {}),
              ...(state ? { state } : {}),
            },
          }),
        );
      }

      throw new Error(`unsupported research_state action: ${action}`);
    },
  };
}
