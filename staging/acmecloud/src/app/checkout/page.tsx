import Link from "next/link";
import { currentAccount } from "../../server/current-account";
import { SignInRequired } from "../sign-in-required";
import { ConfirmPayment } from "./confirm-payment";

export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  const account = await currentAccount();
  if (!account) return <SignInRequired />;
  const pending = account.pending_change;
  if (!pending) {
    return (
      <>
        <h1>No pending plan change</h1>
        <p>
          <Link href="/settings/billing">Back to billing</Link>
        </p>
      </>
    );
  }
  return <ConfirmPayment pending={pending} />;
}
