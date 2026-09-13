"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { BillingPeriod } from "../../../server/fixture";

export function BillingForm({ currentPeriod }: { currentPeriod: BillingPeriod }) {
  const router = useRouter();
  const [period, setPeriod] = useState<BillingPeriod>(currentPeriod);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function upgrade(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);

    const response = await fetch("/api/subscription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "pro", billing_period: period }),
    });
    const outcome = await response.json();

    if (outcome.kind === "checkout") {
      router.push(outcome.checkout_path);
      return;
    }
    if (outcome.kind === "unchanged") {
      setSubmitting(false);
      setMessage(`You are already billed ${period}.`);
    }
  }

  return (
    <form onSubmit={upgrade}>
      <fieldset>
        <legend>Billing period</legend>
        <label>
          <input
            type="radio"
            name="billing_period"
            value="monthly"
            checked={period === "monthly"}
            onChange={() => setPeriod("monthly")}
          />
          Monthly
        </label>
        <label>
          <input
            type="radio"
            name="billing_period"
            value="annual"
            checked={period === "annual"}
            onChange={() => setPeriod("annual")}
          />
          Annual
        </label>
      </fieldset>
      <button type="submit" disabled={submitting}>
        Upgrade
      </button>
      {submitting ? <span role="status" aria-label="Loading" className="spinner" /> : null}
      {message ? <p className="notice">{message}</p> : null}
    </form>
  );
}
