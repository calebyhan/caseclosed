import type { CaseStatus } from "../contracts/lifecycle";

// Presentation helpers shared by server and client components (no hooks, no directive).

/** Deterministic UTC formatting so server and client render identical markup. */
export function formatTimestamp(ms: number | null): string {
  if (ms === null) return "—";
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms} ms`;
  const seconds = ms / 1_000;
  if (seconds < 120) return `${seconds.toFixed(1)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

const STATUS_TONE: Record<CaseStatus, "neutral" | "active" | "good" | "bad" | "warn"> = {
  RECEIVED: "active",
  SPEC_CREATED: "active",
  SPEC_FAILED: "warn",
  REPRODUCING: "active",
  REPRODUCED: "bad",
  NOT_REPRODUCED: "neutral",
  REPRO_INCONCLUSIVE: "warn",
  ISSUE_FILED: "bad",
  WAITING_FOR_FIX: "neutral",
  FIX_MERGED: "active",
  WAITING_FOR_DEPLOYMENT: "neutral",
  VERIFYING: "active",
  VERIFIED_FIXED: "good",
  STILL_BROKEN: "bad",
  VERIFICATION_INCONCLUSIVE: "warn",
};

/** Accepts case statuses and run results (which share the verdict tones). */
export function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status as CaseStatus] ?? (status === "INCONCLUSIVE" ? "warn" : "neutral");
  return <span className={`badge badge-${tone}`}>{status}</span>;
}
