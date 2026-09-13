import { isCaseId } from "../../../../domain/identity";
import { getDatabase } from "../../../../server/composition";
import { getCaseDetail } from "../../../../server/services/case-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  if (!isCaseId(id)) {
    return Response.json(
      { error: "invalid_case_id", message: "Case IDs look like CC-0042." },
      { status: 400 },
    );
  }
  const detail = getCaseDetail(getDatabase(), id);
  if (!detail) {
    return Response.json({ error: "case_not_found", message: `No case ${id} exists.` }, { status: 404 });
  }
  return Response.json(detail, { headers: { "Cache-Control": "no-store" } });
}
