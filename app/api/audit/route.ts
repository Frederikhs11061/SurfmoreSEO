import { NextRequest } from "next/server";
import { runAudit } from "@/lib/audit";
import { runFullSiteAudit, runBatchAudit } from "@/lib/fullAudit";
import { loadCachedAudit, saveCachedAudit } from "@/lib/auditCache";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = (body.url || "surfmore.dk").toString().trim();
    const fullSite = !!body.fullSite;
    const urlBatch = Array.isArray(body.urlBatch) ? body.urlBatch : null;
    const origin = (body.origin || url).toString().trim();
    const forceRefresh = !!body.forceRefresh;

    // Batch audit (ikke cached - altid frisk)
    if (urlBatch?.length) {
      const result = await runBatchAudit(urlBatch.map((u: string) => String(u).trim()).filter(Boolean), origin);
      return Response.json(result, {
        headers: {
          "Cache-Control": "public, max-age=3600, immutable",
        },
      });
    }
    
    if (!url) {
      return Response.json({ error: "URL mangler" }, { status: 400 });
    }
    
    // Full site audit - brug cache hvis ikke force refresh
    if (fullSite) {
      if (!forceRefresh) {
        const cached = await loadCachedAudit(url);
        if (cached) {
          return Response.json(cached, {
            headers: {
              "Cache-Control": "public, max-age=3600, immutable",
            },
          });
        }
      }
      
      const result = await runFullSiteAudit(url);
      
      // Gem i cache
      await saveCachedAudit(url, result);
      
      return Response.json(result, {
        headers: {
          "Cache-Control": "public, max-age=3600, immutable",
        },
      });
    }
    
    // Single page audit (ikke cached)
    const result = await runAudit(url);
    return Response.json(result, {
      headers: {
        "Cache-Control": "public, max-age=3600, immutable",
      },
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
