import { expect, test } from "bun:test";
import { readLinuxProcessStartTicks } from "../../src/update/process-start-identity";

test("Linux /proc stat field 22 survives parenthesized spaces and malformed input", () => {
  if (process.platform !== "linux") return;
  const columns = ["S", ...Array(18).fill("1"), "987654"];
  expect(readLinuxProcessStartTicks(123, () => "123 (weird ) process name) " + columns.join(" "))).toBe("987654");
  expect(readLinuxProcessStartTicks(123, () => "123 (proc) S 5")).toBeNull();
  expect(readLinuxProcessStartTicks(123, () => "124 (wrong) " + columns.join(" "))).toBeNull();
  expect(readLinuxProcessStartTicks(123, () => "123 (bad) " + columns.slice(0, -1).join(" ") + " not-a-number")).toBeNull();
  expect(readLinuxProcessStartTicks(123, () => { throw new Error("ENOENT"); })).toBeNull();
  expect(readLinuxProcessStartTicks(-1)).toBeNull();
});
