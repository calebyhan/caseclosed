import { buildInfo } from "../../../server/build-info";
import { acmeBuildVariant } from "../../../server/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({ ...buildInfo(), variant: acmeBuildVariant() }, { headers: { "Cache-Control": "no-store" } });
}
