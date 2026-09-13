import { z } from "zod";
import { getDatabase } from "../../../../server/composition";
import { loadConfig } from "../../../../server/config";
import { verifySharedSecret } from "../../../../server/integrations/signatures";
import { acceptDeploymentReady } from "../../../../server/services/deployment-ready";

export const runtime = "nodejs";

const Body = z.strictObject({
  pr: z.number().int().positive(),
  commit_sha: z.string().regex(/^[0-9a-f]{7,64}$/i),
  retry: z.boolean().optional(),
  retry_of_run_id: z.string().uuid().optional(),
});

export async function POST(request: Request): Promise<Response> {
  const config = loadConfig();
  if (!config.stagingTestSecret || !config.github) return Response.json({ error: "deployment integration is not configured" }, { status: 503 });
  if (!verifySharedSecret(request.headers.get("x-caseclosed-secret"), config.stagingTestSecret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let raw: unknown;
  try { raw = await request.json(); } catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const body = Body.safeParse(raw);
  if (!body.success) return Response.json({ error: "invalid_body", issues: body.error.issues }, { status: 400 });
  const outcome = acceptDeploymentReady(getDatabase(), body.data, { repository: config.github.repository });
  return outcome.ok ? Response.json(outcome.response) : Response.json({ error: outcome.reason }, { status: 409 });
}
