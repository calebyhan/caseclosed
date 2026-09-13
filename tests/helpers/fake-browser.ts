import type { BrowserAction } from "../../src/contracts/repro";
import type { ConsoleEvent, NetworkEvent } from "../../src/contracts/run";
import type { EnvironmentFailure, SessionCookie, StagingEnvironment } from "../../src/server/browser/environment";
import type { ActionExecution, BrowserLauncher, BrowserSession, ProbeReading, ProbeTarget, RunClock, SessionOptions } from "../../src/server/browser/session";
import type { StepResolutionRequest, StepResolver } from "../../src/server/model/resolve-step";

// Deterministic stand-ins for the browser boundary, used to test the loop,
// budgets, and persistence without Chromium. Real browser behavior is covered
// by tests/e2e against an actual page.

export const STAGING = "http://localhost:3001";

export function fakeClock(): RunClock & { advance(ms: number): void } {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += Math.max(0, ms);
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

type ElementState = { count: number; visible: boolean };
type Scheduled = { at: number; apply: (app: FakeApp) => void };

export type FakeApp = {
  url: string;
  elements: Map<string, ElementState>;
  texts: Set<string>;
  network: Array<Omit<NetworkEvent, "seq" | "phase">>;
  onClick: Map<string, (app: FakeApp, at: number) => Scheduled[]>;
};

const key = (role: string, name: string) => `${role}|${name}`;

function billingApp(onUpgrade: (at: number) => Scheduled[]): FakeApp {
  return {
    url: `${STAGING}/settings/billing`,
    elements: new Map([
      [key("radio", "Monthly"), { count: 1, visible: true }],
      [key("radio", "Annual"), { count: 1, visible: true }],
      [key("button", "Upgrade"), { count: 1, visible: true }],
    ]),
    texts: new Set(["Billing"]),
    network: [],
    onClick: new Map([
      [key("radio", "Annual"), () => []],
      [
        key("button", "Upgrade"),
        (app: FakeApp, at: number) => {
          app.elements.set(key("status", "Loading"), { count: 1, visible: true });
          return onUpgrade(at);
        },
      ],
    ]),
  };
}

/** Buggy build: POST 500 and a spinner that never clears. */
export function buggyApp(): FakeApp {
  return billingApp((at) => [
    { at: at + 100, apply: (app) => app.network.push({ method: "POST", url: `${STAGING}/api/subscription`, status: 500, timestamp_ms: at + 100, same_origin: true }) },
  ]);
}

/** Fixed build: POST 200 then navigation to checkout; the spinner unmounts. */
export function fixedApp(): FakeApp {
  return billingApp((at) => [
    { at: at + 100, apply: (app) => app.network.push({ method: "POST", url: `${STAGING}/api/subscription`, status: 200, timestamp_ms: at + 100, same_origin: true }) },
    {
      at: at + 300,
      apply: (app) => {
        app.url = `${STAGING}/checkout`;
        app.elements = new Map([[key("heading", "Checkout"), { count: 1, visible: true }]]);
        app.network.push({ method: "GET", url: `${STAGING}/checkout`, status: 200, timestamp_ms: at + 300, same_origin: true });
      },
    },
  ]);
}

export class FakeSession implements BrowserSession {
  private scheduled: Scheduled[] = [];
  private readonly networkEvents: NetworkEvent[] = [];
  private readonly consoleEvents: ConsoleEvent[] = [];
  private experimentStarted = false;
  private seq = 0;
  private consumed = 0;
  closed = false;
  executed: BrowserAction[] = [];

  constructor(
    private readonly app: FakeApp,
    private readonly clock: RunClock,
    private readonly behavior: { uncertainOn?: string; snapshot?: string } = {},
  ) {}

  private tick(): void {
    const now = this.clock.now();
    const due = this.scheduled.filter((item) => item.at <= now).sort((a, b) => a.at - b.at);
    this.scheduled = this.scheduled.filter((item) => item.at > now);
    for (const item of due) item.apply(this.app);
    for (const event of this.app.network.slice(this.consumed)) {
      this.networkEvents.push({ ...event, seq: ++this.seq, phase: this.experimentStarted ? "experiment" : "setup" });
    }
    this.consumed = this.app.network.length;
  }

  async goto(path: string): Promise<ActionExecution> {
    this.app.url = `${STAGING}${path}`;
    return { ok: true };
  }

  async execute(action: BrowserAction): Promise<ActionExecution> {
    this.tick();
    this.executed.push(action);
    if (action.type === "wait") {
      await this.clock.sleep(action.milliseconds);
      return { ok: true };
    }
    if (action.type === "goto") return this.goto(action.path);
    if (action.type === "finish") return { ok: false, failure: "not_executed", error: "finish" };
    const target = key(action.role, action.name);
    if (this.behavior.uncertainOn === target) return { ok: false, failure: "uncertain", error: "click failed after dispatch" };
    const element = this.app.elements.get(target);
    if (!element || element.count !== 1 || !element.visible) {
      return { ok: false, failure: "not_executed", error: `no unique visible element (role ${action.role} "${action.name}": ${element?.count ?? 0} matches)` };
    }
    if (action.type === "click") this.scheduled.push(...(this.app.onClick.get(target)?.(this.app, this.clock.now()) ?? []));
    return { ok: true, locatorUsed: "role" };
  }

  markExperimentStart(): void {
    this.tick();
    this.experimentStarted = true;
  }

  currentUrl(): string {
    this.tick();
    return this.app.url;
  }

  async accessibilitySnapshot(): Promise<string> {
    this.tick();
    return this.behavior.snapshot ?? [...this.app.elements.keys()].map((entry) => `- ${entry.replace("|", ' "')}"`).join("\n");
  }

  async screenshot(): Promise<Buffer> {
    return Buffer.from(`png:${this.app.url}`);
  }

  async read(target: ProbeTarget): Promise<ProbeReading> {
    this.tick();
    switch (target.kind) {
      case "element": {
        const element = this.app.elements.get(key(target.role, target.name));
        return { kind: "element", match_count: element?.count ?? 0, visible: element?.visible ?? false };
      }
      case "text":
        return { kind: "text", visible: this.app.texts.has(target.value) };
      case "url":
        return { kind: "url", url: this.app.url };
    }
  }

  network(): NetworkEvent[] {
    this.tick();
    return [...this.networkEvents];
  }

  requestFailures() {
    return [];
  }

  console(): ConsoleEvent[] {
    return [...this.consoleEvents];
  }

  fatalError(): string | null {
    return null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export class FakeLauncher implements BrowserLauncher {
  opens: SessionOptions[] = [];
  sessions: FakeSession[] = [];

  constructor(
    private readonly makeApp: () => FakeApp,
    private readonly behavior: { uncertainOn?: string; throwOnOpen?: boolean; snapshot?: string } = {},
  ) {}

  async open(options: SessionOptions): Promise<BrowserSession> {
    this.opens.push(options);
    if (this.behavior.throwOnOpen) throw new Error("chromium failed to launch");
    const session = new FakeSession(this.makeApp(), options.clock, this.behavior);
    this.sessions.push(session);
    return session;
  }
}

type Outcome<T> = T | EnvironmentFailure;

export class FakeEnvironment implements StagingEnvironment {
  readonly baseUrl = STAGING;
  resets: string[] = [];
  healthChecks = 0;

  constructor(
    private readonly overrides: {
      health?: Outcome<{ ok: true; commitSha: string | null }> | Array<Outcome<{ ok: true; commitSha: string | null }>>;
      reset?: Outcome<{ ok: true }>;
      session?: Outcome<{ ok: true; cookies: SessionCookie[] }>;
    } = {},
  ) {}

  async checkHealth() {
    const health = this.overrides.health;
    const result = Array.isArray(health) ? health[Math.min(this.healthChecks, health.length - 1)] : health;
    this.healthChecks += 1;
    return result ?? { ok: true as const, commitSha: "fake-sha" };
  }

  async resetFixture(fixture: string) {
    this.resets.push(fixture);
    return this.overrides.reset ?? { ok: true as const };
  }

  async createSession() {
    return this.overrides.session ?? { ok: true as const, cookies: [{ name: "acme_test_session", value: "token", url: STAGING }] };
  }
}

export class ScriptedResolver implements StepResolver {
  requests: StepResolutionRequest[] = [];

  constructor(private readonly respond: (request: StepResolutionRequest, callIndex: number) => unknown | Promise<unknown>) {}

  async resolve(request: StepResolutionRequest): Promise<unknown> {
    this.requests.push(request);
    return this.respond(request, this.requests.length - 1);
  }
}

/** Maps the golden billing intents to their landmarks, as a correct model would. */
export function goldenResolver(): ScriptedResolver {
  return new ScriptedResolver((request) => {
    if (/annual/i.test(request.step.intent)) return { type: "click", role: "radio", name: "Annual" };
    if (/upgrade/i.test(request.step.intent)) return { type: "click", role: "button", name: "Upgrade" };
    return { type: "wait", milliseconds: 100 };
  });
}
