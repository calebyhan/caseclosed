import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../../src/server/config";

describe("loadConfig", () => {
  it("resolves defaults to absolute paths under the root", () => {
    const config = loadConfig({}, "/srv/caseclosed");
    assert.equal(config.databasePath, "/srv/caseclosed/var/caseclosed.sqlite");
    assert.equal(config.artifactDir, "/srv/caseclosed/var/artifacts");
    assert.equal(config.stagingBaseUrl, "http://localhost:3001");
    assert.equal(config.stagingTestSecret, null);
  });

  it("treats empty values as unset and trims trailing slashes", () => {
    const config = loadConfig({ DATABASE_PATH: "", PUBLIC_BASE_URL: "https://cc.example.com/" }, "/root");
    assert.equal(config.databasePath, "/root/var/caseclosed.sqlite");
    assert.equal(config.publicBaseUrl, "https://cc.example.com");
  });

  it("fails with actionable messages for invalid values", () => {
    assert.throws(
      () => loadConfig({ PUBLIC_BASE_URL: "not a url", STAGING_TEST_SECRET: "short" }),
      (error: unknown) =>
        error instanceof ConfigError &&
        error.issues.some((issue) => issue.startsWith("PUBLIC_BASE_URL")) &&
        error.issues.some((issue) => issue.includes("STAGING_TEST_SECRET") && issue.includes("16")),
    );
  });
});
