import { z } from "zod";
import { isFixtureId, resetFixture } from "../../../../server/fixture";
import { rejectUnlessTestSecret } from "../../../../server/test-secret";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ResetBody = z.object({ fixture: z.string().min(1) });

export async function POST(request: Request): Promise<Response> {
  const denied = rejectUnlessTestSecret(request);
  if (denied) return denied;

  const body = ResetBody.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "invalid_body", message: 'Expected { "fixture": "<fixture id>" }.' }, { status: 400 });
  }
  if (!isFixtureId(body.data.fixture)) {
    return Response.json({ error: "unknown_fixture", fixture: body.data.fixture }, { status: 400 });
  }
  resetFixture(body.data.fixture);
  return Response.json({ fixture: body.data.fixture, reset: true }, { headers: { "Cache-Control": "no-store" } });
}
