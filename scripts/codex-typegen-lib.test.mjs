import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildTypegenCommandSpec,
  getCodexCliCommand,
  replaceGeneratedTypesAtomically,
} from "./codex-typegen-lib.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createDestination() {
  const root = mkdtempSync(join(tmpdir(), "hyo-codex-typegen-test-"));
  temporaryRoots.push(root);
  const outputDirectory = join(root, "generated");
  mkdirSync(outputDirectory);
  writeFileSync(join(outputDirectory, "Existing.ts"), "export type Existing = true;\n");
  return { outputDirectory, root };
}

describe("replaceGeneratedTypesAtomically", () => {
  it("leaves the existing output untouched when generation fails", () => {
    const { outputDirectory } = createDestination();

    expect(() =>
      replaceGeneratedTypesAtomically({
        outputDirectory,
        generatorVersion: "0.144.1",
        generateInto: (temporaryOutput) => {
          mkdirSync(temporaryOutput);
          writeFileSync(
            join(temporaryOutput, "Partial.ts"),
            "export type Partial = bigint;\n",
          );
          throw new Error("generator failed");
        },
      }),
    ).toThrow("generator failed");

    expect(readFileSync(join(outputDirectory, "Existing.ts"), "utf8")).toBe(
      "export type Existing = true;\n",
    );
  });

  it("normalizes bigint wire types and replaces output only after validation", () => {
    const { outputDirectory } = createDestination();

    const result = replaceGeneratedTypesAtomically({
      outputDirectory,
      generatorVersion: "0.144.1",
      generateInto: (temporaryOutput) => {
        mkdirSync(join(temporaryOutput, "v2"), { recursive: true });
        writeFileSync(
          join(temporaryOutput, "Count.ts"),
          "// GENERATED CODE! DO NOT MODIFY BY HAND!\nexport type Count = bigint;\n",
        );
        writeFileSync(
          join(temporaryOutput, "v2", "Timestamp.ts"),
          "export type Timestamp = bigint | null;\n",
        );
      },
    });

    expect(result).toEqual({ filesChanged: 2, replacements: 2, typeFiles: 2 });
    expect(() => readFileSync(join(outputDirectory, "Existing.ts"), "utf8")).toThrow();
    const count = readFileSync(join(outputDirectory, "Count.ts"), "utf8");
    const timestamp = readFileSync(
      join(outputDirectory, "v2", "Timestamp.ts"),
      "utf8",
    );
    expect(count).toContain("HYO POSTPROCESS");
    expect(count).toContain("export type Count = number;");
    expect(timestamp).toContain("export type Timestamp = number | null;");
    expect(`${count}${timestamp}`).not.toMatch(/\bbigint\b/);
    expect(readFileSync(join(outputDirectory, "CODEX_CLI_VERSION"), "utf8")).toBe(
      "0.144.1\n",
    );
    expect(readFileSync(join(outputDirectory, "HYO_WIRE_TYPES.md"), "utf8")).toMatch(
      /JSON numbers.*bigint.*number/is,
    );
  });
});

describe("Windows Codex typegen command", () => {
  it("honors CODEX_CLI_PATH and safely wraps a cmd shim", () => {
    const command = getCodexCliCommand({
      CODEX_CLI_PATH: "C:\\npm tools\\codex.cmd",
    });

    expect(command).toBe("C:\\npm tools\\codex.cmd");
    expect(
      buildTypegenCommandSpec(command, ["app-server", "generate-ts"], {
        platform: "win32",
        env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      }),
    ).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: [
        "/d",
        "/s",
        "/c",
        '""C:\\npm tools\\codex.cmd" app-server generate-ts"',
      ],
      windowsVerbatimArguments: true,
    });
  });
});
