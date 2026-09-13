import Link from "next/link";
import { currentAccount } from "../../server/current-account";
import { SignInRequired } from "../sign-in-required";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const account = await currentAccount();
  if (!account) return <SignInRequired />;
  return (
    <>
      <h1>Dashboard</h1>
      <p>Signed in as {account.email}</p>
      <p>
        Plan: Pro · billed {account.billing_period}. <Link href="/settings/billing">Manage billing</Link>
      </p>
    </>
  );
}
