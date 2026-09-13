import { acmeBuildVariant, PlanChangeError, PlanChangeRequest, requestPlanChange } from "../../../server/billing";
import { accountFromRequest, unauthenticatedResponse } from "../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const account = accountFromRequest(request);
  if (!account) return unauthenticatedResponse();

  const body = PlanChangeRequest.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ error: "invalid_body", issues: body.error.issues.map((issue) => issue.message) }, { status: 400 });
  }

  try {
    return Response.json(requestPlanChange(account.id, body.data), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PlanChangeError) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    console.error("[acmecloud] plan change failed", error);
    return Response.json(
      {
        error: "internal_error",
        // The superficial revision clears its spinner while preserving the
        // broken backend. Eval 3 must still fail on network + checkout facts.
        ...(acmeBuildVariant() === "superficial" ? { clear_spinner: true } : {}),
      },
      { status: 500 },
    );
  }
}
