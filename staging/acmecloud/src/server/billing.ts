import { z } from "zod";
import { getAccount, saveAccount, type Account, type BillingPeriod } from "./fixture";

type Price = { plan: "pro"; billing_period: BillingPeriod; amount_cents: number; interval: "month" | "year" };

const PRICE_BOOK: Price[] = [{ plan: "pro", billing_period: "monthly", amount_cents: 2_000, interval: "month" }];

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
