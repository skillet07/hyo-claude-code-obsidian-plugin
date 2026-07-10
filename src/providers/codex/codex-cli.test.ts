import { describe, expect, it } from "vitest";
import {
  MINIMUM_CODEX_CLI_VERSION,
  assertCodexCliVersion,
  buildElectronSafePath,
  parseCodexVersion,
} from "./codex-cli";

describe("Codex CLI version checks", () => {
  it("parses Codex CLI semantic versions", () => {
    expect(parseCodexVersion("codex-cli 0.144.1\n")).toEqual({
      major: 0,
      minor: 144,
      patch: 1,
      raw: "0.144.1",
    });
    expect(parseCodexVersion("codex 1.2.3-beta.1")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
      raw: "1.2.3-beta.1",
    });
  });

  it("rejects unrecognized version output", () => {
    expect(() => parseCodexVersion("codex-cli unknown")).toThrow(
      /Could not parse Codex CLI version/,
    );
  });

  it("accepts the minimum supported version", () => {
    expect(
      assertCodexCliVersion({
        runVersion: () => "codex-cli 0.144.1",
      }),
    ).toMatchObject({ raw: MINIMUM_CODEX_CLI_VERSION });
  });

  it("does not treat a prerelease as satisfying the stable minimum", () => {
    expect(() =>
      assertCodexCliVersion({ runVersion: () => "codex-cli 0.144.1-beta.1" }),
    ).toThrow(/requires 0\.144\.1/);
  });

  it("reports an actionable error for an old CLI", () => {
    expect(() =>
      assertCodexCliVersion({ runVersion: () => "codex-cli 0.143.9" }),
    ).toThrow(/Found 0\.143\.9.*requires 0\.144\.1.*update/i);
  });

  it("reports an actionable error when the CLI is missing", () => {
    const missing = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    expect(() =>
      assertCodexCliVersion({
        runVersion: () => {
          throw missing;
        },
      }),
    ).toThrow(/Codex CLI was not found.*install.*PATH/i);
  });

  it("adds common GUI-missing executable directories without losing PATH", () => {
    const path = buildElectronSafePath("/custom/bin:/usr/bin", "/Users/tester");
    const entries = path.split(":");

    expect(entries).toEqual(
      expect.arrayContaining([
        "/Users/tester/.local/bin",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/custom/bin",
      ]),
    );
    expect(new Set(entries).size).toBe(entries.length);
  });
});
