import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { PlaywrightLauncher } from "../../src/server/browser/playwright-session";
import { systemClock } from "../../src/server/browser/runner";

let baseUrl = "";
let releaseResponse: (() => void) | null = null;

const server = createServer(async (request, response) => {
  if (request.url === "/start") {
    response.writeHead(200, { "content-type": "text/html" });
    response.end('<script>fetch("/api/subscription")</script><main>ready</main>');
    return;
  }
  if (request.url === "/api/subscription") {
    await new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    response.writeHead(500, { "content-type": "application/json" });
    response.end('{"error":"late setup response"}');
    return;
  }
  response.writeHead(404).end();
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  releaseResponse?.();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("Playwright network observation epoch", () => {
  it("keeps a response in setup when its request began before the experiment", async () => {
    const session = await new PlaywrightLauncher().open({
      baseUrl,
      cookies: [],
      clock: systemClock(),
      knownSecrets: [],
      actionTimeoutMs: 5_000,
    });
    try {
      assert.ok((await session.goto("/start")).ok);
      for (let attempt = 0; attempt < 100 && !releaseResponse; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.ok(releaseResponse, "start-page request should be pending");
      session.markExperimentStart();
      releaseResponse();
      for (let attempt = 0; attempt < 100 && !session.network().some((event) => event.url.includes("/api/subscription")); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const target = session.network().find((event) => event.url.includes("/api/subscription"));
      assert.ok(target);
      assert.equal(target.phase, "setup");
    } finally {
      await session.close();
    }
  });
});
