import { currentAccount } from "../../../server/current-account";
import { SignInRequired } from "../../sign-in-required";
import { BillingForm } from "./billing-form";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const account = await currentAccount();
  if (!account) return <SignInRequired />;
  return (
    <>
      <h1>Billing</h1>
      <p>
        You are on the Pro plan, billed <strong>{account.billing_period}</strong>.
      </p>
      <BillingForm currentPeriod={account.billing_period} />
    </>
  );
}
