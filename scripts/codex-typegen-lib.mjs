import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

const postprocessNote =
  "// HYO POSTPROCESS: JSON 64-bit integer wire declarations normalized to number; see HYO_WIRE_TYPES.md.\n";

export function replaceGeneratedTypesAtomically({
  outputDirectory,
  generatorVersion,
  generateInto,
}) {
  const parentDirectory = dirname(outputDirectory);
  const outputName = basename(outputDirectory);
  mkdirSync(parentDirectory, { recursive: true });
  const temporaryRoot = mkdtempSync(join(parentDirectory, `.${outputName}.tmp-`));
  const temporaryOutput = join(temporaryRoot, outputName);
  const backupDirectory = join(
    parentDirectory,
    `.${outputName}.backup-${randomUUID()}`,
  );
  let backupCreated = false;
  let swapCompleted = false;

  try {
    generateInto(temporaryOutput);
    const result = normalizeBigIntWireTypes(temporaryOutput);
    if (result.typeFiles === 0) {
      throw new Error("Codex type generation produced no TypeScript files");
    }
    validateNoBigIntWireTypes(temporaryOutput);
    writeFileSync(
      join(temporaryOutput, "CODEX_CLI_VERSION"),
      `${generatorVersion}\n`,
      "utf8",
    );
    writeFileSync(
      join(temporaryOutput, "HYO_WIRE_TYPES.md"),
      [
        "# Hyo Codex wire type normalization",
        "",
        "App-server JSON numbers are parsed by JSON.parse as JavaScript numbers.",
        "The Codex generator emits some bigint declarations for counts, limits, durations, and timestamps;",
        "Hyo normalizes those declarations to number so exposed production types match runtime values.",
        "These protocol values are expected to remain within JavaScript's safe integer range.",
        "",
      ].join("\n"),
      "utf8",
    );

    if (existsSync(outputDirectory)) {
      renameSync(outputDirectory, backupDirectory);
      backupCreated = true;
    }
    try {
      renameSync(temporaryOutput, outputDirectory);
      swapCompleted = true;
    } catch (error) {
      if (backupCreated && !existsSync(outputDirectory)) {
        renameSync(backupDirectory, outputDirectory);
        backupCreated = false;
      }
      throw error;
    }
    return result;
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
    if (swapCompleted && backupCreated) {
      rmSync(backupDirectory, { recursive: true, force: true });
    }
  }
}

export function normalizeBigIntWireTypes(outputDirectory) {
  const typeFiles = listTypeScriptFiles(outputDirectory);
  let filesChanged = 0;
  let replacements = 0;

  for (const file of typeFiles) {
    const original = readFileSync(file, "utf8");
    const matches = original.match(/\bbigint\b/g);
    if (!matches) continue;
    replacements += matches.length;
    filesChanged += 1;
    const normalized = original.replace(/\bbigint\b/g, "number");
    writeFileSync(file, `${postprocessNote}${normalized}`, "utf8");
  }

  return { filesChanged, replacements, typeFiles: typeFiles.length };
}

function validateNoBigIntWireTypes(outputDirectory) {
  const remaining = listTypeScriptFiles(outputDirectory).filter((file) =>
    /\bbigint\b/.test(readFileSync(file, "utf8")),
  );
  if (remaining.length > 0) {
    throw new Error(
      `Generated Codex bindings still contain bigint declarations: ${remaining.join(", ")}`,
    );
  }
}

function listTypeScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listTypeScriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}
