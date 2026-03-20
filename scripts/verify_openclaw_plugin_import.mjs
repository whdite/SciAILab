import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const moduleUrl = pathToFileURL(
    path.join(repoRoot, "openclaw", "extensions", "research-core", "index.ts"),
  ).href;
  process.stdout.write("phase:import\n");
  const mod = await import(moduleUrl);
  const entry = mod.default;
  process.stdout.write("phase:register\n");
  const calls = [];

  const api = {
    pluginConfig: {},
    logger: {
      info() {},
      warn() {},
    },
    registrationMode: "full",
    registerGatewayMethod(name) {
      calls.push({ kind: "gateway", name });
    },
    registerService(service) {
      calls.push({ kind: "service", name: service.id });
    },
    registerTool(tool) {
      calls.push({ kind: "tool", name: tool.name });
    },
  };

  entry.register(api);

  const toolNames = calls.filter((item) => item.kind === "tool").map((item) => item.name).sort();
  const gatewayNames = calls.filter((item) => item.kind === "gateway").map((item) => item.name).sort();
  const serviceNames = calls.filter((item) => item.kind === "service").map((item) => item.name).sort();

  assert.equal(entry.id, "research-core");
  assert.equal(toolNames.length, 9);
  assert.equal(gatewayNames.length, 19);
  assert.deepEqual(serviceNames, ["research-core-coordinator-service"]);
  assert.ok(toolNames.includes("research_control"));
  assert.ok(gatewayNames.includes("research.control.agent_routing.get"));
  assert.ok(gatewayNames.includes("research.control.agent_routing.update"));
  assert.ok(gatewayNames.includes("research.control.agent_activation.set"));
  assert.ok(gatewayNames.includes("research.control.scheduler_state.get"));

  const summary = {
    plugin_id: entry.id,
    tool_count: toolNames.length,
    service_count: serviceNames.length,
    gateway_count: gatewayNames.length,
    tool_names: toolNames,
    gateway_names: gatewayNames,
    service_names: serviceNames,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
