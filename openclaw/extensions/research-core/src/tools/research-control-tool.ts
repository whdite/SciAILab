import { Type } from "@sinclair/typebox";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import type { ResolvedResearchPaths } from "../project-paths.js";
import { runResearchRequest } from "../research-service.js";

const AgentRouteSchema = Type.Object(
  {
    role: Type.String({ description: "Coordinator role: explorer, experiment, writer, reviewer." }),
    active: Type.Optional(Type.Boolean()),
    provider: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    authProfile: Type.Optional(Type.String()),
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  },
  { additionalProperties: false },
);

const ResearchControlToolSchema = Type.Object(
  {
    action: Type.Union([
      Type.Literal("routing_get"),
      Type.Literal("routing_update"),
      Type.Literal("activation_set"),
      Type.Literal("scheduler_state"),
    ]),
    routes: Type.Optional(Type.Array(AgentRouteSchema)),
    role: Type.Optional(Type.String()),
    active: Type.Optional(Type.Boolean()),
    maxConcurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })),
  },
  { additionalProperties: false },
);

export function createResearchControlTool(
  _api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
) {
  return {
    name: "research_control",
    label: "Research Control",
    description: "Inspect and update coordinator routing, activation, and scheduler state.",
    parameters: ResearchControlToolSchema,
    execute: async (_toolCallId: string, rawParams: Record<string, unknown>) => {
      const action = readStringParam(rawParams, "action", { required: true });

      if (action === "routing_get") {
        return jsonResult(
          await runResearchRequest(paths, {
            method: "GET",
            route: "/v1/control/agent-routing",
            fallbackCommand: "list_agent_routing",
            fallbackPayload: {},
          }),
        );
      }

      if (action === "routing_update") {
        const routes = rawParams.routes;
        if (!Array.isArray(routes) || routes.length === 0) {
          throw new Error("routes is required for action=routing_update");
        }
        const payload = {
          routes: routes.map((item, index) => {
            if (!item || typeof item !== "object" || Array.isArray(item)) {
              throw new Error(`routes[${String(index)}] must be an object`);
            }
            const route = item as Record<string, unknown>;
            const role = readStringParam(route, "role", { required: true });
            const result: Record<string, unknown> = { role };
            if ("active" in route) {
              if (typeof route.active !== "boolean") {
                throw new Error(`routes[${String(index)}].active must be a boolean`);
              }
              result.active = route.active;
            }
            if ("provider" in route) {
              if (typeof route.provider !== "string") {
                throw new Error(`routes[${String(index)}].provider must be a string`);
              }
              result.provider = route.provider;
            }
            if ("model" in route) {
              if (typeof route.model !== "string") {
                throw new Error(`routes[${String(index)}].model must be a string`);
              }
              result.model = route.model;
            }
            if ("authProfile" in route) {
              if (typeof route.authProfile !== "string") {
                throw new Error(`routes[${String(index)}].authProfile must be a string`);
              }
              result.auth_profile = route.authProfile;
            }
            if ("maxConcurrency" in route) {
              if (
                typeof route.maxConcurrency !== "number" ||
                !Number.isFinite(route.maxConcurrency) ||
                !Number.isInteger(route.maxConcurrency)
              ) {
                throw new Error(`routes[${String(index)}].maxConcurrency must be an integer`);
              }
              result.max_concurrency = route.maxConcurrency;
            }
            return result;
          }),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/control/agent-routing",
            body: payload,
            fallbackCommand: "upsert_agent_routing",
            fallbackPayload: payload,
          }),
        );
      }

      if (action === "activation_set") {
        const role = readStringParam(rawParams, "role", { required: true });
        if (typeof rawParams.active !== "boolean") {
          throw new Error("active is required for action=activation_set");
        }
        const payload = {
          role,
          active: rawParams.active,
          ...(typeof rawParams.maxConcurrency === "number"
            ? { max_concurrency: rawParams.maxConcurrency }
            : {}),
        };
        return jsonResult(
          await runResearchRequest(paths, {
            method: "POST",
            route: "/v1/control/agent-activation",
            body: payload,
            fallbackCommand: "set_agent_activation",
            fallbackPayload: payload,
          }),
        );
      }

      if (action === "scheduler_state") {
        return jsonResult(
          await runResearchRequest(paths, {
            method: "GET",
            route: "/v1/control/scheduler-state",
            fallbackCommand: "build_scheduler_control_state",
            fallbackPayload: {},
          }),
        );
      }

      throw new Error(`unsupported research_control action: ${action}`);
    },
  };
}
