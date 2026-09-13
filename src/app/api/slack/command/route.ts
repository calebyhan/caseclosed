import { getDatabase } from "../../../../server/composition";
import { loadConfig } from "../../../../server/config";
import { verifySlackSignature } from "../../../../server/integrations/signatures";
import { createCaseFromReport, IntakeValidationError } from "../../../../server/services/intake";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const config = loadConfig();
  if (!config.slack) return Response.json({ error: "Slack integration is not configured" }, { status: 503 });
  const raw = await request.text();
  const verified = verifySlackSignature(
    raw,
    request.headers.get("x-slack-request-timestamp"),
    request.headers.get("x-slack-signature"),
    config.slack.signingSecret,
  );
  if (!verified.ok) return Response.json({ error: verified.reason }, { status: 401 });
  const form = new URLSearchParams(raw);
  if (form.get("command") !== "/caseclosed") return Response.json({ error: "unexpected_command" }, { status: 400 });
  try {
    const result = createCaseFromReport(getDatabase(), {
      source: {
        type: "slack",
        teamId: form.get("team_id") ?? "",
        channelId: form.get("channel_id") ?? "",
        userId: form.get("user_id") ?? "",
        triggerId: form.get("trigger_id") ?? "",
      },
      report: form.get("text") ?? "",
      environmentId: config.environmentId,
    });
    return Response.json({
      response_type: "ephemeral",
      text: `${result.caseId} ${result.created ? "created" : "already exists"}. Reproduction is queued: ${config.publicBaseUrl}/case/${result.caseId}`,
    });
  } catch (error) {
    if (error instanceof IntakeValidationError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
