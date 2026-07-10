import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { replaceGeneratedTypesAtomically } from "./codex-typegen-lib.mjs";

const generatorVersion = "0.144.1";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const outputDirectory = fileURLToPath(
  new URL("../src/providers/codex/generated", import.meta.url),
);

const versionOutput = execFileSync("codex", ["--version"], {
  cwd: projectRoot,
  encoding: "utf8",
  timeout: 3_000,
}).trim();
const match = versionOutput.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
if (!match || match[1] !== generatorVersion) {
  throw new Error(
    `Codex type generation requires codex-cli ${generatorVersion}; found ${JSON.stringify(versionOutput)}.`,
  );
}

const result = replaceGeneratedTypesAtomically({
  outputDirectory,
  generatorVersion,
  generateInto: (temporaryOutput) => {
    execFileSync(
      "codex",
      ["app-server", "generate-ts", "--out", temporaryOutput],
      { cwd: projectRoot, stdio: "inherit" },
    );
  },
});

console.log(
  `Generated ${result.typeFiles} stable Codex types; normalized ${result.replacements} bigint declarations across ${result.filesChanged} files.`,
);
