import { accountFromRequest, unauthenticatedResponse } from "../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const account = accountFromRequest(request);
  if (!account) return unauthenticatedResponse();
  return Response.json(account, { headers: { "Cache-Control": "no-store" } });
}
