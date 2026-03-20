import { definePluginEntry, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { createResearchCoordinatorService } from "./src/coordinator-agent.js";
import { createResearchEventTool } from "./src/tools/research-event-tool.js";
import { createResearchFreezeTool } from "./src/tools/research-freeze-tool.js";
import { createResearchMessageTool } from "./src/tools/research-message-tool.js";
import { createResearchStateTool } from "./src/tools/research-state-tool.js";
import { createResearchTaskTool } from "./src/tools/research-task-tool.js";
import { createResearchCoordinatorTool } from "./src/tools/research-coordinator-tool.js";
import { createResearchControlTool } from "./src/tools/research-control-tool.js";
import { registerResearchGatewayMethods } from "./src/gateway-methods.js";
import { resolveResearchPluginConfig } from "./src/project-paths.js";
import { createResearchArtifactTool } from "./src/tools/research-artifact-tool.js";
import { createResearchProjectTool } from "./src/tools/research-project-tool.js";

export default definePluginEntry({
  id: "research-core",
  name: "Research Core",
  description: "SciAILab project control-plane and Python runtime bridge",
  register(api) {
    const config = resolveResearchPluginConfig(api.pluginConfig);
    if (config.enabled === false) {
      api.logger.info("[research-core] plugin disabled by config");
      return;
    }

    registerResearchGatewayMethods(api, config);
    api.registerService(createResearchCoordinatorService(api, config));
    api.registerTool(createResearchProjectTool(api, config) as AnyAgentTool);
    api.registerTool(createResearchArtifactTool(api, config) as AnyAgentTool);
    api.registerTool(createResearchMessageTool(api, config) as AnyAgentTool);
    api.registerTool(createResearchEventTool(api, config) as AnyAgentTool);
    api.registerTool(createResearchFreezeTool(api, config) as AnyAgentTool);
    api.registerTool(createResearchTaskTool(api, config) as AnyAgentTool);
    api.registerTool(createResearchStateTool(api, config) as AnyAgentTool);
    api.registerTool(createResearchCoordinatorTool(api, config) as AnyAgentTool);
    api.registerTool(createResearchControlTool(api, config) as AnyAgentTool);
  },
});
