// Process-local fixture store for the controlled staging app. This is test
// data for experiments, not CaseClosed state. Every build starts seeded and
// every CaseClosed run resets it.

export type BillingPeriod = "monthly" | "annual";

export type PendingChange = {
  plan: "pro";
  billing_period: BillingPeriod;
  amount_cents: number;
  interval: "month" | "year";
};

export type Account = {
  id: string;
  email: string;
  plan: "pro";
  billing_period: BillingPeriod;
  pending_change: PendingChange | null;
};

const FIXTURE_SEEDS = {
  pro_monthly_customer: {
    id: "pro_monthly_customer",
    email: "test@acmecloud.local",
    plan: "pro",
    billing_period: "monthly",
    pending_change: null,
  },
} as const satisfies Record<string, Account>;

export type FixtureId = keyof typeof FIXTURE_SEEDS;

export const FIXTURE_IDS = Object.keys(FIXTURE_SEEDS) as FixtureId[];

export function isFixtureId(value: string): value is FixtureId {
  return Object.hasOwn(FIXTURE_SEEDS, value);
}

type FixtureStore = { accounts: Map<string, Account> };

// Cached on globalThis so route handlers and pages share one store in a process.
const holder = globalThis as unknown as { __acmeFixtureStore?: FixtureStore };

function seededAccounts(): Map<string, Account> {
  return new Map(Object.values(FIXTURE_SEEDS).map((seed) => [seed.id, structuredClone(seed) as Account]));
}

function store(): FixtureStore {
  holder.__acmeFixtureStore ??= { accounts: seededAccounts() };
  return holder.__acmeFixtureStore;
}

export function fixtureSeed(id: FixtureId): Account {
  return structuredClone(FIXTURE_SEEDS[id]) as Account;
}

/**
 * Restores every account to its seed. Idempotent: repeated resets always
 * yield identical state, regardless of what happened in between.
 */
export function resetFixture(id: FixtureId): Account {
  store().accounts = seededAccounts();
  return getAccount(FIXTURE_SEEDS[id].id)!;
}

export function getAccount(accountId: string): Account | null {
  const account = store().accounts.get(accountId);
  return account ? structuredClone(account) : null;
}

export function saveAccount(account: Account): Account {
  if (!store().accounts.has(account.id)) throw new Error(`Unknown account ${account.id}`);
  store().accounts.set(account.id, structuredClone(account));
  return structuredClone(account);
}
