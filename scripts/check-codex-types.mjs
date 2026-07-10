import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  checkGeneratedTypes,
  getCodexCliCommand,
  runTypegenCommandSync,
} from "./codex-typegen-lib.mjs";

const generatorVersion = "0.144.1";
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const committedDirectory = fileURLToPath(
  new URL("../src/providers/codex/generated", import.meta.url),
);
const codexCommand = getCodexCliCommand(process.env);

try {
  const versionOutput = runTypegenCommandSync(codexCommand, ["--version"], {
    cwd: projectRoot,
    timeout: 3_000,
  }).trim();
  const match = versionOutput.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/);
  if (!match || match[1] !== generatorVersion) {
    throw new Error(
      `Generated binding checks require codex-cli ${generatorVersion}; found ${JSON.stringify(versionOutput)}. Set CODEX_CLI_PATH to the pinned CLI.`,
    );
  }

  const result = checkGeneratedTypes({
    committedDirectory,
    generatorVersion,
    temporaryParent: tmpdir(),
    generateInto: (temporaryOutput) => {
      runTypegenCommandSync(
        codexCommand,
        ["app-server", "generate-ts", "--out", temporaryOutput],
        { cwd: projectRoot },
      );
    },
  });
  if (!result.matches) {
    const detail = result.differences.slice(0, 50).map((line) => `  - ${line}`).join("\n");
    const omitted = result.differences.length > 50
      ? `\n  - …and ${result.differences.length - 50} more`
      : "";
    throw new Error(
      `Committed Codex bindings have drifted:\n${detail}${omitted}\nRun npm run codex:generate-types with codex-cli ${generatorVersion}, review the generated diff, and commit it.`,
    );
  }
  console.log(
    `Codex bindings match codex-cli ${generatorVersion} (${result.generated.typeFiles} TypeScript files).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
