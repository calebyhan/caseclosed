import { z } from "zod";
import { getAccount, saveAccount, type Account, type BillingPeriod } from "./fixture";

type Price = { plan: "pro"; billing_period: BillingPeriod; amount_cents: number; interval: "month" | "year" };

/**
 * The controlled staging target deliberately has three deployable revisions.
 * This is build identity, not a runtime product toggle: the eval runner starts
 * a fresh staging process for each revision and verifies the reported SHA.
 */
export type AcmeBuildVariant = "buggy" | "superficial" | "fixed";

export function acmeBuildVariant(): AcmeBuildVariant {
  if (process.env.ACME_BUILD_VARIANT && process.env.CASECLOSED_EVAL_MODE !== "1") {
    throw new Error("ACME_BUILD_VARIANT is only available in explicit eval mode");
  }
  // Ordinary builds must ship the real annual price. Buggy and superficial
  // revisions are available only to the explicit eval/demo harness.
  const value = process.env.CASECLOSED_EVAL_MODE === "1"
    ? (process.env.ACME_BUILD_VARIANT ?? "buggy")
    : "fixed";
  if (value === "buggy" || value === "superficial" || value === "fixed") return value;
  throw new Error(`Unsupported ACME_BUILD_VARIANT: ${value}`);
}

const PRICE_BOOK: Price[] = [
  { plan: "pro", billing_period: "monthly", amount_cents: 2_000, interval: "month" },
  { plan: "pro", billing_period: "annual", amount_cents: 20_000, interval: "year" },
];

export const PlanChangeRequest = z.object({
  plan: z.literal("pro"),
  billing_period: z.enum(["monthly", "annual"]),
  confirm: z.boolean().default(false),
});
export type PlanChangeRequest = z.infer<typeof PlanChangeRequest>;

export type PlanChangeOutcome =
  | { kind: "unchanged"; account: Account }
  | { kind: "checkout"; account: Account; checkout_path: "/checkout" }
  | { kind: "confirmed"; account: Account };

export class PlanChangeError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "PlanChangeError";
  }
}

function priceFor(plan: "pro", period: BillingPeriod): Price {
  // The price-book entry is the real fix. Controlled buggy and superficial
  // revisions deliberately hide it so the demo/evals can exercise the same
  // failure before deploying the fixed revision.
  if (period === "annual" && acmeBuildVariant() !== "fixed") return undefined!;
  return PRICE_BOOK.find((price) => price.plan === plan && price.billing_period === period)!;
}

export function requestPlanChange(accountId: string, request: PlanChangeRequest): PlanChangeOutcome {
  const account = getAccount(accountId);
  if (!account) throw new PlanChangeError("account_not_found", 404);

  if (request.confirm) {
    const pending = account.pending_change;
    if (!pending || pending.plan !== request.plan || pending.billing_period !== request.billing_period) {
      throw new PlanChangeError("no_matching_pending_change", 409);
    }
    return {
      kind: "confirmed",
      account: saveAccount({ ...account, plan: pending.plan, billing_period: pending.billing_period, pending_change: null }),
    };
  }

  if (account.plan === request.plan && account.billing_period === request.billing_period) {
    return { kind: "unchanged", account };
  }

  const price = priceFor(request.plan, request.billing_period);
  const updated = saveAccount({
    ...account,
    pending_change: {
      plan: request.plan,
      billing_period: request.billing_period,
      amount_cents: price.amount_cents,
      interval: price.interval,
    },
  });
  return { kind: "checkout", account: updated, checkout_path: "/checkout" };
}
