import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const openclawRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const packageJsonPath = path.join(openclawRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const created = [];
  const overwritten = [];
  const force = process.argv.includes("--force");

  for (const [subpath, target] of Object.entries(packageJson.exports ?? {})) {
    if (!subpath.startsWith("./plugin-sdk/")) {
      continue;
    }
    const defaultTarget =
      typeof target === "string"
        ? target
        : target && typeof target === "object" && !Array.isArray(target)
          ? target.default
          : undefined;
    if (typeof defaultTarget !== "string") {
      continue;
    }
    if (!defaultTarget.startsWith("./dist/plugin-sdk/") || !defaultTarget.endsWith(".js")) {
      continue;
    }

    const distPath = path.join(openclawRoot, defaultTarget.slice(2));
    const fileBase = path.basename(defaultTarget, ".js");
    const sourcePath = path.join(openclawRoot, "src", "plugin-sdk", `${fileBase}.ts`);
    try {
      await fs.access(sourcePath);
    } catch {
      continue;
    }

    let distExists = true;
    try {
      await fs.access(distPath);
    } catch {
      distExists = false;
    }
    if (distExists && !force) {
      continue;
    }

    const relativeSource = path
      .relative(path.dirname(distPath), sourcePath)
      .replace(/\\/g, "/");
    await fs.mkdir(path.dirname(distPath), { recursive: true });
    await fs.writeFile(distPath, `export * from "${relativeSource}";\n`, "utf8");
    const outputPath = path.relative(openclawRoot, distPath).replace(/\\/g, "/");
    if (distExists) {
      overwritten.push(outputPath);
    } else {
      created.push(outputPath);
    }
  }

  process.stdout.write(`${JSON.stringify({ force, created, overwritten }, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
