import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const generatorVersion = "0.144.1";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = fileURLToPath(
  new URL("../src/providers/codex/generated", import.meta.url),
);

const versionOutput = execFileSync("codex", ["--version"], {
  cwd: projectRoot,
  encoding: "utf8",
}).trim();
const match = versionOutput.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
if (!match || match[1] !== generatorVersion) {
  throw new Error(
    `Codex type generation requires codex-cli ${generatorVersion}; found ${JSON.stringify(versionOutput)}.`,
  );
}

rmSync(outputDirectory, { recursive: true, force: true });
execFileSync(
  "codex",
  ["app-server", "generate-ts", "--out", outputDirectory],
  { cwd: projectRoot, stdio: "inherit" },
);
writeFileSync(
  `${outputDirectory}/CODEX_CLI_VERSION`,
  `${generatorVersion}\n`,
  "utf8",
);
