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
import { spawnSync as nodeSpawnSync } from "node:child_process";
import { basename, dirname, join, win32 } from "node:path";

const postprocessNote =
  "// HYO POSTPROCESS: JSON 64-bit integer wire declarations normalized to number; see HYO_WIRE_TYPES.md.\n";

export function getCodexCliCommand(env = process.env) {
  return env.CODEX_CLI_PATH?.trim() || "codex";
}

export function buildTypegenCommandSpec(
  command,
  args,
  {
    platform = process.platform,
    env = process.env,
    fileExists = existsSync,
    comspec,
  } = {},
) {
  if (platform !== "win32") return { file: command, args };
  const resolved = resolveWindowsCommand(command, env, fileExists);
  if (!/\.(?:cmd|bat)$/i.test(resolved)) return { file: resolved, args };

  assertSafeWindowsToken(resolved);
  for (const argument of args) assertSafeWindowsToken(argument);
  const argumentText = args.map(quoteWindowsToken).join(" ");
  return {
    file: comspec ?? env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    args: [
      "/d",
      "/s",
      "/c",
      `""${resolved}"${argumentText ? ` ${argumentText}` : ""}"`,
    ],
    windowsVerbatimArguments: true,
  };
}

export function runTypegenCommandSync(
  command,
  args,
  {
    platform = process.platform,
    env = process.env,
    cwd,
    timeout,
    stdio,
    spawnSync = nodeSpawnSync,
  } = {},
) {
  const spec = buildTypegenCommandSpec(command, args, { platform, env });
  const result = spawnSync(spec.file, spec.args, {
    cwd,
    env,
    encoding: stdio === "inherit" ? undefined : "utf8",
    stdio,
    timeout,
    windowsHide: true,
    windowsVerbatimArguments: spec.windowsVerbatimArguments,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
    throw new Error(
      stderr ||
        `Codex type generation command exited with status ${String(result.status)}`,
    );
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

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
    const result = generateStableTypes({
      outputDirectory: temporaryOutput,
      generatorVersion,
      generateInto,
    });

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

export function checkGeneratedTypes({
  committedDirectory,
  generatorVersion,
  generateInto,
  temporaryParent,
}) {
  mkdirSync(temporaryParent, { recursive: true });
  const temporaryRoot = mkdtempSync(join(temporaryParent, "hyo-codex-types-check-"));
  const temporaryOutput = join(temporaryRoot, "generated");
  try {
    const generated = generateStableTypes({
      outputDirectory: temporaryOutput,
      generatorVersion,
      generateInto,
    });
    const differences = compareDirectoryTrees(
      committedDirectory,
      temporaryOutput,
    );
    return {
      matches: differences.length === 0,
      differences,
      generated,
    };
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function generateStableTypes({ outputDirectory, generatorVersion, generateInto }) {
  generateInto(outputDirectory);
  const result = normalizeBigIntWireTypes(outputDirectory);
  if (result.typeFiles === 0) {
    throw new Error("Codex type generation produced no TypeScript files");
  }
  validateNoBigIntWireTypes(outputDirectory);
  writeFileSync(
    join(outputDirectory, "CODEX_CLI_VERSION"),
    `${generatorVersion}\n`,
    "utf8",
  );
  writeFileSync(
    join(outputDirectory, "HYO_WIRE_TYPES.md"),
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
  return result;
}

function compareDirectoryTrees(committedDirectory, generatedDirectory) {
  const committedFiles = listFiles(committedDirectory);
  const generatedFiles = listFiles(generatedDirectory);
  const paths = [...new Set([...committedFiles.keys(), ...generatedFiles.keys()])].sort();
  const differences = [];
  for (const path of paths) {
    if (!generatedFiles.has(path)) {
      differences.push(`missing from generated output: ${path}`);
    } else if (!committedFiles.has(path)) {
      differences.push(`missing from committed bindings: ${path}`);
    } else if (!committedFiles.get(path).equals(generatedFiles.get(path))) {
      differences.push(`content differs: ${path}`);
    }
  }
  return differences;
}

function listFiles(root, directory = root, files = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) listFiles(root, path, files);
    else if (entry.isFile()) {
      const relativePath = path.slice(root.length + 1).replaceAll("\\", "/");
      files.set(relativePath, readFileSync(path));
    }
  }
  return files;
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

function resolveWindowsCommand(command, env, fileExists) {
  if (
    command.includes("\\") ||
    command.includes("/") ||
    /\.[A-Za-z0-9]+$/.test(command)
  ) {
    return command;
  }
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(win32.delimiter)
    .filter(Boolean);
  for (const directory of (env.PATH ?? "").split(win32.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = win32.join(directory, `${command}${extension}`);
      if (fileExists(candidate)) return candidate;
    }
  }
  return command;
}

function assertSafeWindowsToken(value) {
  if (/["&|<>^%!\r\n]/.test(value)) {
    throw new Error(
      `Unsafe Windows command text cannot be passed through a Codex npm shim: ${JSON.stringify(value)}`,
    );
  }
}

function quoteWindowsToken(value) {
  return /\s/.test(value) ? `"${value}"` : value;
}
