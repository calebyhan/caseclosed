import type { BrowserAction } from "../../contracts/repro";
import type { ConsoleEvent, LocatorStrategy, NetworkEvent, RequestFailure } from "../../contracts/run";
import type { SessionCookie } from "./environment";

// Browser boundary used by the reproduction loop. The Playwright
// implementation lives in playwright-session.ts; tests substitute fakes.

export type ActionExecution =
  | { ok: true; locatorUsed?: LocatorStrategy }
  | {
      ok: false;
      /** not_executed: no interaction was dispatched, so re-resolving is safe. */
      failure: "not_executed" | "uncertain";
      error: string;
      navigationBlocked?: boolean;
    };

export type ProbeTarget =
  | { kind: "element"; role: string; name: string }
  | { kind: "text"; value: string }
  | { kind: "url" };

export type ProbeReading =
  | { kind: "element"; match_count: number; visible: boolean }
  | { kind: "text"; visible: boolean }
  | { kind: "url"; url: string };

export type RunClock = {
  /** Monotonic milliseconds since the run started. */
  now(): number;
  sleep(ms: number): Promise<void>;
};

export type SessionOptions = {
  baseUrl: string;
  cookies: SessionCookie[];
  clock: RunClock;
  knownSecrets: readonly (string | null | undefined)[];
  actionTimeoutMs: number;
};

export interface BrowserSession {
  goto(path: string): Promise<ActionExecution>;
  /** Executes a click/fill/select/wait action. */
  execute(action: BrowserAction): Promise<ActionExecution>;
  /** Network responses before this call are `setup` traffic. */
  markExperimentStart(): void;
  currentUrl(): string;
  accessibilitySnapshot(): Promise<string>;
  screenshot(): Promise<Buffer>;
  read(target: ProbeTarget): Promise<ProbeReading>;
  network(): NetworkEvent[];
  requestFailures(): RequestFailure[];
  console(): ConsoleEvent[];
  /** Set when the page crashed, a popup opened, or navigation left the origin. */
  fatalError(): string | null;
  close(): Promise<void>;
}

export interface BrowserLauncher {
  open(options: SessionOptions): Promise<BrowserSession>;
}
