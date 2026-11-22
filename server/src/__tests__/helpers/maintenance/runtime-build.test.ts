import { describe, expect, it } from "vitest";
import { maintenanceRuntimePackageManager } from "./runtime-build.js";

const node = "/usr/local/bin/node";

describe("maintenance runtime package manager", () => {
  it("uses pnpm when the test process was started by pnpm", () => {
    const execPath = "/usr/local/lib/node_modules/pnpm/bin/pnpm.cjs";
    expect(maintenanceRuntimePackageManager({ npm_execpath: execPath }, node)).toEqual({
      command: node,
      prefix: [execPath],
    });
  });

  it("falls back to pnpm when the launcher is npm, which cannot run --filter", () => {
    expect(
      maintenanceRuntimePackageManager(
        { npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js" },
        node,
      ),
    ).toEqual({ command: "pnpm", prefix: [] });
  });

  it("falls back to pnpm for another package manager's JavaScript entry point", () => {
    expect(
      maintenanceRuntimePackageManager({ npm_execpath: "/usr/local/bin/yarn.js" }, node),
    ).toEqual({ command: "pnpm", prefix: [] });
  });

  it("keeps a native pnpm shim as the command", () => {
    expect(
      maintenanceRuntimePackageManager({ npm_execpath: "/usr/local/bin/pnpm" }, node),
    ).toEqual({ command: "/usr/local/bin/pnpm", prefix: [] });
  });

  it("uses pnpm when nothing names a launcher", () => {
    expect(maintenanceRuntimePackageManager({}, node)).toEqual({ command: "pnpm", prefix: [] });
    expect(maintenanceRuntimePackageManager({ npm_execpath: "  " }, node)).toEqual({
      command: "pnpm",
      prefix: [],
    });
  });
});
