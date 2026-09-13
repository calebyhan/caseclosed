import { cookies } from "next/headers";
import type { Account } from "./fixture";
import { accountFromToken, SESSION_COOKIE } from "./session";

/** Account for the current page request, or null when no valid test session exists. */
export async function currentAccount(): Promise<Account | null> {
  const cookieStore = await cookies();
  return accountFromToken(cookieStore.get(SESSION_COOKIE)?.value);
}
