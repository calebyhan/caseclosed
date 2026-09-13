import fs from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDatabase } from "../../../../server/composition";
import { loadConfig } from "../../../../server/config";
import { evidence } from "../../../../server/db/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const item = getDatabase().select().from(evidence).where(eq(evidence.id, id)).get();
  if (!item) return Response.json({ error: "evidence_not_found" }, { status: 404 });

  const root = path.resolve(loadConfig().artifactDir);
  const absolute = path.resolve(root, item.relativePath);
  if (!absolute.startsWith(`${root}${path.sep}`)) {
    return Response.json({ error: "invalid_evidence_path" }, { status: 400 });
  }
  try {
    const bytes = await fs.readFile(absolute);
    return new Response(bytes, {
      headers: {
        "Content-Type": item.mimeType,
        "Content-Disposition": `inline; filename="${path.basename(item.relativePath).replaceAll('"', "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Response.json({ error: "evidence_file_missing" }, { status: 404 });
    }
    throw error;
  }
}
