import { NextRequest } from "next/server";
import { runAudit } from "@/lib/audit";
import { runFullSiteAudit, runBatchAudit } from "@/lib/fullAudit";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = (body.url || "surfmore.dk").toString().trim();
    const fullSite = !!body.fullSite;
    const urlBatch = Array.isArray(body.urlBatch) ? body.urlBatch : null;
    const origin = (body.origin || url).toString().trim();

    if (urlBatch?.length) {
      const result = await runBatchAudit(urlBatch.map((u: string) => String(u).trim()).filter(Boolean), origin);
      return Response.json(result);
    }
    if (!url) {
      return Response.json({ error: "URL mangler" }, { status: 400 });
    }
    if (fullSite) {
      const result = await runFullSiteAudit(url);
      return Response.json(result);
    }
    const result = await runAudit(url);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
