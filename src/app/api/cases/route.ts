import { getDatabase } from "../../../server/composition";
import { listRecentCases } from "../../../server/services/case-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ cases: listRecentCases(getDatabase()) }, { headers: { "Cache-Control": "no-store" } });
}
