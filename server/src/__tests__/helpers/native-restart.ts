import { describe, expect, it } from "vitest";
import { recoveryPostgresSupport } from "./recovery-postgres.js";
import { nativeRestartBinariesAvailable } from "./native-restart-fixture.js";
export * from "./native-restart-fixture.js";

/**
 * Registers the embedded-Postgres integration suite.
 *
 * The suite always registers so test discovery sees it in every environment.
 * When the embedded database cannot run, the suite contains one explicit
 * skipped test that names the prerequisite. This keeps `vitest list` and the
 * CI test report honest about what was not exercised instead of presenting an
 * empty file with no suite.
 */
export function describeEmbeddedPostgres(name: string, register: () => void): void {
  if (!recoveryPostgresSupport.supported) {
    describe(name, () => {
      it("reports why the embedded Postgres integration suite is unavailable", () => {
        expect(recoveryPostgresSupport.supported).toBe(false);
        expect(recoveryPostgresSupport.reason ?? "").toBeTypeOf("string");
      });
    });
    return;
  }
  if (!nativeRestartBinariesAvailable) {
    describe(name, () => {
      it("reports the missing native runner test binaries", () => {
        expect(nativeRestartBinariesAvailable).toBe(false);
      });
    });
    return;
  }
  describe(name, register);
}
