import { buildInfo } from "../../../server/build-info";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json(buildInfo(), { headers: { "Cache-Control": "no-store" } });
}
