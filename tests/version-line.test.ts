import { describe, expect, test } from "bun:test";
import {
  compareTagsLenient,
  compareVersions,
  nextDevelopmentVersion,
  parseVersion,
} from "../scripts/version-line";

describe("version line algebra", () => {
  test("parses optional v, prerelease identifiers, and ignored build metadata", () => {
    expect(parseVersion(" v2.36.0-preview.20260829+build.1 ")).toEqual({
      major: 2,
      minor: 36,
      patch: 0,
      prerelease: ["preview", "20260829"],
    });
    expect(parseVersion("2.36.0+build.1")).toEqual({
      major: 2,
      minor: 36,
      patch: 0,
      prerelease: null,
    });
    expect(parseVersion("not-a-version")).toBeNull();
    expect(parseVersion("2.36")).toBeNull();
    expect(parseVersion("garbage")).toBeNull();
  });

  test("orders SemVer cores and prerelease identifiers", () => {
    expect(compareVersions("2.36.0-preview.2", "2.36.0-preview.10")).toBeLessThan(0);
    expect(compareVersions("2.36.0-preview.10", "2.36.0-preview.beta")).toBeLessThan(0);
    expect(compareVersions("2.36.0-preview.1", "2.36.0")).toBeLessThan(0);
    expect(compareVersions("2.37.0-preview.1", "2.36.0")).toBeGreaterThan(0);
    expect(compareVersions("v2.36.0", "2.36.0")).toBe(0);
  });

  test("ignores build metadata for strict release precedence", () => {
    expect(compareVersions("2.19.4", "2.19.3+build.1")).toBeGreaterThan(0);
    expect(compareVersions("2.19.3", "2.19.3+build.1")).toBe(0);
    expect(() => compareVersions("2.19.4", "not-a-version")).toThrow(/unparseable/);
  });

  test("keeps historical tag sorting lenient while release decisions fail closed", () => {
    const fallback = "vNOTAVERSION".localeCompare("v2.42.0", undefined, {
      numeric: true,
      sensitivity: "base",
    });
    expect(compareTagsLenient("vNOTAVERSION", "v2.42.0")).toBe(fallback);
    expect(() => compareVersions("vNOTAVERSION", "v2.42.0")).toThrow(/unparseable/);
  });

  test("a stable release is succeeded by the next minor", () => {
    expect(nextDevelopmentVersion("2.36.0")).toBe("2.37.0");
    expect(nextDevelopmentVersion("2.33.0")).toBe("2.34.0");
    expect(nextDevelopmentVersion("v2.36.0")).toBe("2.37.0");
  });

  test("a prerelease is succeeded by its own stable core", () => {
    expect(nextDevelopmentVersion("2.36.0-preview.20260829")).toBe("2.36.0");
    expect(nextDevelopmentVersion("2.36.0-preview.20260829")).not.toBe("2.37.0");
    expect(nextDevelopmentVersion("v2.36.0-preview.20260829")).toBe("2.36.0");
  });

  test("refuses malformed released versions instead of guessing", () => {
    expect(() => nextDevelopmentVersion("not-a-version")).toThrow(/not parseable/);
    expect(() => nextDevelopmentVersion("2.36")).toThrow(/not parseable/);
    expect(() => nextDevelopmentVersion("garbage")).toThrow(/not parseable/);
  });
});
