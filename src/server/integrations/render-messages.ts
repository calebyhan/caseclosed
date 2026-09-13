type Check = { id?: string; passed?: boolean; expected?: string; observed?: string };

function checks(value: unknown): Check[] {
  return Array.isArray(value) ? value.filter((item): item is Check => Boolean(item && typeof item === "object")) : [];
}

function failures(payload: Record<string, unknown>): string {
  const failed = checks(payload.assertions).filter((item) => !item.passed).map((item) => `${item.id ?? "assertion"}: ${item.observed ?? "failed"}`);
  const matched = checks(payload.failure_signals).filter((item) => item.passed).map((item) => `${item.id ?? "signal"}: ${item.observed ?? "matched"}`);
  return [...failed, ...matched].slice(0, 6).join("\n");
}

export function renderSlack(effectType: string, payload: Record<string, unknown>, caseUrl: string): string {
  const id = String(payload.case_id ?? "CaseClosed case");
  if (effectType === "slack.post_case_root") return `*${id} created* — reproduction started.\n${caseUrl}`;
  if (payload.kind === "insufficient") return `*${id}: more detail needed*\n${(payload.reasons as string[] | undefined)?.join("\n") ?? "The report was not testable."}`;
  if (payload.kind === "validation_failed") return `*${id}: reproduction could not be constructed*\n${(payload.reasons as string[] | undefined)?.join("\n") ?? "The generated experiment was invalid."}`;
  if (payload.linear_identifier) return `*${id}: engineering issue filed* — ${payload.linear_identifier}\n${payload.linear_url ?? ""}`;
  if (payload.commit_sha && !payload.result) return `*${id}: fix deployed* — verification started for ${String(payload.commit_sha).slice(0, 12)}.`;
  switch (payload.result) {
    case "REPRODUCED": return `*${id}: REPRODUCED* — Linear issue creation started.\n${payload.evidence_summary ?? ""}\n${caseUrl}`;
    case "NOT_REPRODUCED": return `*${id}: NOT_REPRODUCED*\n${payload.evidence_summary ?? ""}\n${caseUrl}`;
    case "VERIFIED_FIXED": return `*${id}: VERIFIED_FIXED* — the original experiment now passes.\n${payload.evidence_summary ?? ""}\n${caseUrl}`;
    case "STILL_BROKEN": return `*${id}: STILL_BROKEN* — the original customer failure remains.\n${failures(payload)}\n${caseUrl}`;
    case "INCONCLUSIVE": return `*${id}: INCONCLUSIVE* — verification could not be trusted (${payload.infra_error_reason ?? "incomplete experiment"}).\n${caseUrl}`;
    default: return `*${id} update*\n${caseUrl}`;
  }
}

export function renderLinearIssue(payload: Record<string, unknown>, caseUrl: string): { title: string; description: string } {
  const steps = Array.isArray(payload.steps)
    ? payload.steps.map((step, index) => `${index + 1}. ${String((step as { intent?: unknown }).intent ?? "")}`).join("\n")
    : "";
  const assertionRows = checks(payload.assertions).map((item) => `- ${item.id}: expected ${item.expected}; observed ${item.observed}`).join("\n");
  const signalRows = checks(payload.failure_signals).filter((item) => item.passed).map((item) => `- ${item.id}: ${item.observed}`).join("\n");
  return {
    title: `[${payload.case_id}] ${payload.goal ?? "Reproduced customer bug"}`,
    description: [
      `CaseClosed case: ${payload.case_id}`,
      `Case: ${caseUrl}`,
      "",
      "## Original report",
      String(payload.report ?? ""),
      "",
      "## Expected vs actual",
      assertionRows || "See CaseClosed evidence.",
      "",
      "## Reproduction steps",
      steps,
      "",
      "## Evidence summary",
      String(payload.evidence_summary ?? ""),
      signalRows,
    ].join("\n"),
  };
}

export function renderVerificationComment(payload: Record<string, unknown>, caseUrl: string): string {
  const result = String(payload.result);
  if (result === "VERIFIED_FIXED") return `CaseClosed verification: PASS\n\nAll required assertions passed and the original failure signals were absent.\n\n${caseUrl}`;
  if (result === "STILL_BROKEN") return `CaseClosed verification: FAIL — original customer-reported failure remains reproducible.\n\n${failures(payload)}\n\n${caseUrl}`;
  return `CaseClosed verification: INCONCLUSIVE — the original experiment could not be completed reliably (${payload.infra_error_reason ?? "incomplete evidence"}).\n\n${caseUrl}`;
}
