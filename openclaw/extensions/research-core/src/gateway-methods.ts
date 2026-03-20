import { readNumberParam, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-runtime";
import { asCoordinatorRole, runResearchCoordinatorPass } from "./coordinator-agent.js";
import type { ResolvedResearchPaths } from "./project-paths.js";
import { runResearchRequest } from "./research-service.js";

type GatewayRespond = (ok: boolean, payload?: unknown) => void;
type JsonRecord = Record<string, unknown>;

function respondError(respond: GatewayRespond, error: unknown): void {
  respond(false, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function readOptionalStringValue(source: JsonRecord, key: string): string | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readOptionalBooleanValue(source: JsonRecord, key: string): boolean | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readOptionalIntegerValue(
  source: JsonRecord,
  key: string,
  {
    min,
    max,
  }: {
  min: number;
  max: number;
}): number | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer`);
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${String(min)} and ${String(max)}`);
  }
  return value;
}

function readAgentRouteUpdates(params: Record<string, unknown>): JsonRecord[] {
  if (!Array.isArray(params.routes)) {
    throw new Error("routes must be an array");
  }
  return params.routes.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`routes[${String(index)}] must be an object`);
    }
    const route = item as JsonRecord;
    const role = readStringParam(route, "role", { required: true });
    const active = readOptionalBooleanValue(route, "active");
    const provider = readOptionalStringValue(route, "provider");
    const model = readOptionalStringValue(route, "model");
    const authProfile = readOptionalStringValue(route, "auth_profile");
    const maxConcurrency = readOptionalIntegerValue(route, "max_concurrency", {
      min: 1,
      max: 32,
    });
    return {
      role,
      ...(active === undefined ? {} : { active }),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(authProfile === undefined ? {} : { auth_profile: authProfile }),
      ...(maxConcurrency === undefined ? {} : { max_concurrency: maxConcurrency }),
    };
  });
}

export function registerResearchGatewayMethods(
  _api: OpenClawPluginApi,
  paths: ResolvedResearchPaths,
): void {
  _api.registerGatewayMethod("research.project.create", async ({ params, respond }) => {
    try {
      const name = readStringParam(params, "name", { required: true });
      const goal = readStringParam(params, "goal") ?? "";
      const ownerAgent = readStringParam(params, "ownerAgent") ?? "control-plane";
      const projectId = readStringParam(params, "projectId");
      const payload = {
        name,
        goal,
        owner_agent: ownerAgent,
        ...(projectId ? { project_id: projectId } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "POST",
        route: "/v1/projects",
        body: payload,
        fallbackCommand: "create_project",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.project.status", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const result = await runResearchRequest(paths, {
        method: "GET",
        route: `/v1/projects/${encodeURIComponent(projectId)}`,
        fallbackCommand: "get_project_status",
        fallbackPayload: { project_id: projectId },
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.control.agent_routing.get", async ({ respond }) => {
    try {
      const result = await runResearchRequest(paths, {
        method: "GET",
        route: "/v1/control/agent-routing",
        fallbackCommand: "list_agent_routing",
        fallbackPayload: {},
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.control.agent_routing.update", async ({ params, respond }) => {
    try {
      const routes = readAgentRouteUpdates(params);
      const payload = { routes };
      const result = await runResearchRequest(paths, {
        method: "POST",
        route: "/v1/control/agent-routing",
        body: payload,
        fallbackCommand: "upsert_agent_routing",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.control.agent_activation.set", async ({ params, respond }) => {
    try {
      const role = readStringParam(params, "role", { required: true });
      const active = readOptionalBooleanValue(params, "active");
      if (active === undefined) {
        throw new Error("active is required");
      }
      const maxConcurrency = readOptionalIntegerValue(params, "max_concurrency", {
        min: 1,
        max: 32,
      });
      const payload = {
        role,
        active,
        ...(maxConcurrency === undefined ? {} : { max_concurrency: maxConcurrency }),
      };
      const result = await runResearchRequest(paths, {
        method: "POST",
        route: "/v1/control/agent-activation",
        body: payload,
        fallbackCommand: "set_agent_activation",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.control.scheduler_state.get", async ({ respond }) => {
    try {
      const result = await runResearchRequest(paths, {
        method: "GET",
        route: "/v1/control/scheduler-state",
        fallbackCommand: "build_scheduler_control_state",
        fallbackPayload: {},
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.artifact.list", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const result = await runResearchRequest(paths, {
        method: "GET",
        route: `/v1/projects/${encodeURIComponent(projectId)}/artifacts`,
        fallbackCommand: "list_artifacts",
        fallbackPayload: { project_id: projectId },
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.message.send", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const fromAgent = readStringParam(params, "fromAgent", { required: true });
      const toAgent = readStringParam(params, "toAgent", { required: true });
      const messageType = readStringParam(params, "messageType", { required: true });
      const content = readStringParam(params, "content", { required: true });
      const priority = readStringParam(params, "priority") ?? "normal";
      const artifactRef = readStringParam(params, "artifactRef");
      const payload = {
        project_id: projectId,
        from_agent: fromAgent,
        to_agent: toAgent,
        message_type: messageType,
        content,
        priority,
        ...(artifactRef ? { artifact_ref: artifactRef } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "POST",
        route: "/v1/messages",
        body: payload,
        fallbackCommand: "create_message",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.message.list", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const toAgent = readStringParam(params, "toAgent");
      const status = readStringParam(params, "status");
      const query = new URLSearchParams();
      if (toAgent) query.set("to_agent", toAgent);
      if (status) query.set("status", status);
      const payload = {
        project_id: projectId,
        ...(toAgent ? { to_agent: toAgent } : {}),
        ...(status ? { status } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "GET",
        route: `/v1/projects/${encodeURIComponent(projectId)}/messages`,
        query,
        fallbackCommand: "list_messages",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.event.emit", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const eventType = readStringParam(params, "eventType", { required: true });
      const source = readStringParam(params, "source", { required: true });
      const eventPayload =
        params.payload && typeof params.payload === "object" && !Array.isArray(params.payload)
          ? (params.payload as Record<string, unknown>)
          : undefined;
      const payload = {
        project_id: projectId,
        event_type: eventType,
        source,
        ...(eventPayload ? { payload: eventPayload } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "POST",
        route: "/v1/events",
        body: payload,
        fallbackCommand: "emit_event",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.event.list", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const status = readStringParam(params, "status");
      const eventType = readStringParam(params, "eventType");
      const query = new URLSearchParams();
      if (status) query.set("status", status);
      if (eventType) query.set("event_type", eventType);
      const payload = {
        project_id: projectId,
        ...(status ? { status } : {}),
        ...(eventType ? { event_type: eventType } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "GET",
        route: `/v1/projects/${encodeURIComponent(projectId)}/events`,
        query,
        fallbackCommand: "list_events",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.event.consume", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const limit =
        typeof params.limit === "number" && Number.isFinite(params.limit)
          ? Math.max(1, Math.min(100, Math.trunc(params.limit)))
          : 20;
      const payload = { project_id: projectId, limit };
      const result = await runResearchRequest(paths, {
        method: "POST",
        route: "/v1/events/consume",
        body: payload,
        fallbackCommand: "consume_events",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.package.freeze", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const packageType = readStringParam(params, "packageType", { required: true });
      const state = readStringParam(params, "state") ?? "frozen";
      const createdFrom = Array.isArray(params.createdFrom)
        ? params.createdFrom.filter((item): item is string => typeof item === "string")
        : undefined;
      const payload = {
        project_id: projectId,
        package_type: packageType,
        state,
        ...(createdFrom ? { created_from: createdFrom } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "POST",
        route: "/v1/packages/freeze",
        body: payload,
        fallbackCommand: "freeze_package",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.package.list", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const packageType = readStringParam(params, "packageType");
      const query = new URLSearchParams();
      if (packageType) query.set("package_type", packageType);
      const payload = {
        project_id: projectId,
        ...(packageType ? { package_type: packageType } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "GET",
        route: `/v1/projects/${encodeURIComponent(projectId)}/packages`,
        query,
        fallbackCommand: "list_packages",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.task.create", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const title = readStringParam(params, "title", { required: true });
      const scope = readStringParam(params, "scope", { required: true });
      const ownerAgent = readStringParam(params, "ownerAgent", { required: true });
      const dependency = readStringParam(params, "dependency");
      const acceptance = readStringParam(params, "acceptance");
      const status = readStringParam(params, "status") ?? "todo";
      const payload = {
        project_id: projectId,
        title,
        scope,
        owner_agent: ownerAgent,
        ...(dependency ? { dependency } : {}),
        ...(acceptance ? { acceptance } : {}),
        status,
      };
      const result = await runResearchRequest(paths, {
        method: "POST",
        route: "/v1/tasks",
        body: payload,
        fallbackCommand: "create_task",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.task.list", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const ownerAgent = readStringParam(params, "ownerAgent");
      const status = readStringParam(params, "status");
      const query = new URLSearchParams();
      if (ownerAgent) query.set("owner_agent", ownerAgent);
      if (status) query.set("status", status);
      const payload = {
        project_id: projectId,
        ...(ownerAgent ? { owner_agent: ownerAgent } : {}),
        ...(status ? { status } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "GET",
        route: `/v1/projects/${encodeURIComponent(projectId)}/tasks`,
        query,
        fallbackCommand: "list_tasks",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.task.update_status", async ({ params, respond }) => {
    try {
      const taskId = readStringParam(params, "taskId", { required: true });
      const status = readStringParam(params, "status", { required: true });
      const source = readStringParam(params, "source");
      const eventType = readStringParam(params, "eventType");
      const eventPayload =
        params.eventPayload &&
        typeof params.eventPayload === "object" &&
        !Array.isArray(params.eventPayload)
          ? (params.eventPayload as Record<string, unknown>)
          : undefined;
      const payload = {
        task_id: taskId,
        status,
        ...(source ? { source } : {}),
        ...(eventType ? { event_type: eventType } : {}),
        ...(eventPayload ? { event_payload: eventPayload } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "POST",
        route: "/v1/tasks/status",
        body: payload,
        fallbackCommand: "update_task_status",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.state.agent_list", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId", { required: true });
      const agentId = readStringParam(params, "agentId");
      const state = readStringParam(params, "state");
      const query = new URLSearchParams();
      if (agentId) query.set("agent_id", agentId);
      if (state) query.set("state", state);
      const payload = {
        project_id: projectId,
        ...(agentId ? { agent_id: agentId } : {}),
        ...(state ? { state } : {}),
      };
      const result = await runResearchRequest(paths, {
        method: "GET",
        route: `/v1/projects/${encodeURIComponent(projectId)}/state/agents`,
        query,
        fallbackCommand: "list_agent_states",
        fallbackPayload: payload,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });

  _api.registerGatewayMethod("research.coordinator.run", async ({ params, respond }) => {
    try {
      const projectId = readStringParam(params, "projectId");
      const ownerAgent = readStringParam(params, "ownerAgent");
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 1;
      const consumeLimit = readNumberParam(params, "consumeLimit", { integer: true }) ?? 20;
      const result = await runResearchCoordinatorPass(_api, paths, {
        projectId: projectId ?? undefined,
        ownerAgent: asCoordinatorRole(ownerAgent),
        limit,
        consumeLimit,
      });
      respond(true, result);
    } catch (error) {
      respondError(respond, error);
    }
  });
}
