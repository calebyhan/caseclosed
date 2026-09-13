import { z } from "zod";
import { fixtureSeed, isFixtureId } from "../../../../server/fixture";
import { mintSessionToken, sessionCookieHeader } from "../../../../server/session";
import { getTestSecret, rejectUnlessTestSecret } from "../../../../server/test-secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SessionBody = z.object({ fixture: z.string().min(1) });

/** Issues the internal test-session cookie for a fixture account. No login workflow. */
export async function POST(request: Request): Promise<Response> {
  const denied = rejectUnlessTestSecret(request);
  if (denied) return denied;

  const body = SessionBody.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "invalid_body", message: 'Expected { "fixture": "<fixture id>" }.' }, { status: 400 });
  }
  if (!isFixtureId(body.data.fixture)) {
    return Response.json({ error: "unknown_fixture", fixture: body.data.fixture }, { status: 400 });
  }
  const accountId = fixtureSeed(body.data.fixture).id;
  const token = mintSessionToken(accountId, getTestSecret()!);
  return Response.json(
    { account_id: accountId },
    { headers: { "Set-Cookie": sessionCookieHeader(token), "Cache-Control": "no-store" } },
  );
}
