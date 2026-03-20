import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const openclawRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const piAiIndexPath = path.join(
    openclawRoot,
    "node_modules",
    "@mariozechner",
    "pi-ai",
    "dist",
    "index.js",
  );
  let source = await fs.readFile(piAiIndexPath, "utf8");
  if (source.includes('export { getOAuthApiKey, getOAuthProviders } from "./oauth.js";')) {
    process.stdout.write(`${JSON.stringify({ patched: false, path: piAiIndexPath }, null, 2)}\n`);
    return;
  }

  source = `${source.trimEnd()}\nexport { getOAuthApiKey, getOAuthProviders } from "./oauth.js";\n`;
  await fs.writeFile(piAiIndexPath, source, "utf8");
  process.stdout.write(`${JSON.stringify({ patched: true, path: piAiIndexPath }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
