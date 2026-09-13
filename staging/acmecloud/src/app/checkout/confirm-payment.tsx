"use client";

import { useState } from "react";
import type { PendingChange } from "../../server/fixture";

export function ConfirmPayment({ pending }: { pending: PendingChange }) {
  const [state, setState] = useState<"idle" | "submitting" | "done" | "failed">("idle");

  async function confirm() {
    setState("submitting");
    const response = await fetch("/api/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: pending.plan, billing_period: pending.billing_period, confirm: true }),
    });
    setState(response.ok ? "done" : "failed");
  }

  if (state === "done") {
    return (
      <>
        <h1>Upgrade complete</h1>
        <p>Your Pro plan is now billed {pending.billing_period}.</p>
      </>
    );
  }

  return (
    <>
      <h1>Checkout</h1>
      <p>
        Pro plan, billed {pending.billing_period}: ${(pending.amount_cents / 100).toFixed(2)} per {pending.interval}.
      </p>
      <button type="button" onClick={confirm} disabled={state === "submitting"}>
        Confirm payment
      </button>
      {state === "failed" ? <p className="notice">Payment could not be confirmed.</p> : null}
    </>
  );
}
