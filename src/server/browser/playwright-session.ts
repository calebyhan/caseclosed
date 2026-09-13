import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from "playwright";
import type { BrowserAction } from "../../contracts/repro";
import type { ConsoleEvent, LocatorStrategy, NetworkEvent, RequestFailure } from "../../contracts/run";
import { redactText, redactUrl } from "../evidence/redact";
import type { ActionExecution, BrowserLauncher, BrowserSession, ProbeReading, ProbeTarget, SessionOptions } from "./session";

// Playwright implementation. Fresh browser + context per run, fixed viewport,
// locale and timezone, service workers blocked, and every request outside the
// staging origin aborted. No model-supplied JavaScript is ever evaluated.

type AriaRole = Parameters<Page["getByRole"]>[0];

export class PlaywrightLauncher implements BrowserLauncher {
  constructor(private readonly options: { headless?: boolean } = {}) {}

  async open(options: SessionOptions): Promise<BrowserSession> {
    const browser = await chromium.launch({ headless: this.options.headless ?? true });
    try {
      const context = await browser.newContext({
        baseURL: options.baseUrl,
        viewport: { width: 1280, height: 800 },
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
        acceptDownloads: false,
      });
      await context.addCookies(options.cookies);
      const page = await context.newPage();
      const session = new PlaywrightSession(browser, context, page, options);
      await session.initialize();
      return session;
    } catch (error) {
      await browser.close().catch(() => undefined);
      throw error;
    }
  }
}

class PlaywrightSession implements BrowserSession {
  private readonly origin: string;
  private readonly networkEvents: NetworkEvent[] = [];
  private readonly failures: RequestFailure[] = [];
  private readonly consoleEvents: ConsoleEvent[] = [];
  private seq = 0;
  private experimentStarted = false;
  private readonly requestPhases = new WeakMap<Request, "setup" | "experiment">();
  private fatal: string | null = null;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly options: SessionOptions,
  ) {
    this.origin = new URL(options.baseUrl).origin;
    page.setDefaultTimeout(options.actionTimeoutMs);
    page.setDefaultNavigationTimeout(options.actionTimeoutMs);

    context.on("page", (popup) => {
      if (popup === page) return;
      this.fatal = "a popup or new tab opened; multiple pages are unsupported";
      void popup.close().catch(() => undefined);
    });
    page.on("crash", () => {
      this.fatal = "page crashed";
    });
    page.on("request", (request) => {
      this.requestPhases.set(request, this.experimentStarted ? "experiment" : "setup");
    });
    page.on("response", (response) => {
      const request = response.request();
      this.networkEvents.push({
        seq: ++this.seq,
        method: request.method(),
        url: redactUrl(response.url(), options.knownSecrets),
        status: response.status(),
        timestamp_ms: options.clock.now(),
        same_origin: this.sameOrigin(response.url()),
        phase: this.requestPhases.get(request) ?? "setup",
      });
    });
    page.on("requestfailed", (request) => {
      this.failures.push({
        seq: ++this.seq,
        method: request.method(),
        url: redactUrl(request.url(), options.knownSecrets),
        error: request.failure()?.errorText ?? "request failed",
        timestamp_ms: options.clock.now(),
        same_origin: this.sameOrigin(request.url()),
        phase: this.requestPhases.get(request) ?? "setup",
      });
    });
    page.on("console", (message) => {
      this.consoleEvents.push({ seq: ++this.seq, level: message.type(), text: redactText(message.text(), options.knownSecrets), timestamp_ms: options.clock.now() });
    });
    page.on("pageerror", (error) => {
      this.consoleEvents.push({ seq: ++this.seq, level: "pageerror", text: redactText(error.message, options.knownSecrets), timestamp_ms: options.clock.now() });
    });
  }

  /** Install the origin guard before the session can navigate. */
  async initialize(): Promise<void> {
    await this.context.route("**/*", async (route) => {
      const url = route.request().url();
      if (this.isAllowed(url)) return route.continue();
      if (route.request().isNavigationRequest() && route.request().frame() === this.page.mainFrame()) {
        this.fatal = `navigation to a non-staging origin was blocked: ${redactUrl(url, this.options.knownSecrets)}`;
      }
      return route.abort("blockedbyclient");
    });
  }

  markExperimentStart(): void {
    this.experimentStarted = true;
  }

  async goto(path: string): Promise<ActionExecution> {
    try {
      await this.page.goto(path, { waitUntil: "load" });
    } catch (error) {
      return { ok: false, failure: "uncertain", error: `navigation failed: ${message(error)}`, navigationBlocked: this.fatal !== null };
    }
    if (!this.sameOrigin(this.page.url())) {
      return { ok: false, failure: "uncertain", error: "navigation left the staging origin", navigationBlocked: true };
    }
    return { ok: true };
  }

  async execute(action: BrowserAction): Promise<ActionExecution> {
    if (action.type === "wait") {
      await this.page.waitForTimeout(action.milliseconds);
      return { ok: true };
    }
    if (action.type === "goto") return this.goto(action.path);
    if (action.type === "finish") return { ok: false, failure: "not_executed", error: "finish is not executable" };

    const resolved = await this.resolveTarget(action.role, action.name);
    if (!resolved.ok) return { ok: false, failure: "not_executed", error: resolved.error };

    const timeout = this.options.actionTimeoutMs;
    try {
      // Trial runs actionability checks without dispatching input, so a
      // disabled or obscured target is still safely re-resolvable.
      if (action.type === "click") await resolved.locator.click({ trial: true, timeout });
    } catch (error) {
      return { ok: false, failure: "not_executed", error: `target not actionable: ${message(error)}` };
    }
    try {
      if (action.type === "click") await resolved.locator.click({ timeout });
      else if (action.type === "fill") await resolved.locator.fill(action.value, { timeout });
      else await resolved.locator.selectOption(action.value, { timeout });
    } catch (error) {
      return { ok: false, failure: "uncertain", error: `${action.type} failed after dispatch: ${message(error)}` };
    }
    return { ok: true, locatorUsed: resolved.strategy };
  }

  /** Exact role + accessible name must match exactly one visible element. */
  private async resolveTarget(
    role: string,
    name: string,
  ): Promise<{ ok: true; locator: Locator; strategy: LocatorStrategy } | { ok: false; error: string }> {
    const locator = this.page.getByRole(role as AriaRole, { name, exact: true });
    const count = await locator.count();
    if (count !== 1) return { ok: false, error: `no unique visible element (role ${role} "${name}": ${count} matches)` };
    if (!(await locator.isVisible())) return { ok: false, error: `no unique visible element (role ${role} "${name}": not visible)` };
    return { ok: true, locator, strategy: "role" };
  }

  currentUrl(): string {
    return redactUrl(this.page.url(), this.options.knownSecrets);
  }

  async accessibilitySnapshot(): Promise<string> {
    return redactText(await this.page.locator("body").ariaSnapshot({ timeout: this.options.actionTimeoutMs }), this.options.knownSecrets);
  }

  screenshot(): Promise<Buffer> {
    return this.page.screenshot({ timeout: this.options.actionTimeoutMs });
  }

  async read(target: ProbeTarget): Promise<ProbeReading> {
    switch (target.kind) {
      case "element": {
        const locator = this.page.getByRole(target.role as AriaRole, { name: target.name, exact: true });
        const count = await locator.count();
        return { kind: "element", match_count: count, visible: count === 1 ? await locator.isVisible() : false };
      }
      case "text": {
        const visible = await this.page.getByText(target.value, { exact: true }).filter({ visible: true }).count();
        return { kind: "text", visible: visible > 0 };
      }
      case "url":
        return { kind: "url", url: this.currentUrl() };
    }
  }

  network(): NetworkEvent[] {
    return [...this.networkEvents];
  }

  requestFailures(): RequestFailure[] {
    return [...this.failures];
  }

  console(): ConsoleEvent[] {
    return [...this.consoleEvents];
  }

  fatalError(): string | null {
    return this.fatal;
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  private sameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === this.origin;
    } catch {
      return false;
    }
  }

  private isAllowed(url: string): boolean {
    return this.sameOrigin(url) || /^(data|blob|about):/.test(url);
  }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 300);
}
