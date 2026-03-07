import { NextRequest } from "next/server";
import { runAudit } from "@/lib/audit";
import { runFullSiteAudit, runBatchAudit } from "@/lib/fullAudit";
import { loadCachedAudit, saveCachedAudit } from "@/lib/auditCache";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch (parseError) {
      return Response.json({ error: "Invalid JSON in request body" }, { status: 400 });
    }
    
    const url = (body.url || "surfmore.dk").toString().trim();
    const fullSite = !!body.fullSite;
    const urlBatch = Array.isArray(body.urlBatch) ? body.urlBatch : null;
    const origin = (body.origin || url).toString().trim();
    const forceRefresh = !!body.forceRefresh;

    // Batch audit (ikke cached - altid frisk)
    if (urlBatch?.length) {
      try {
        const result = await runBatchAudit(urlBatch.map((u: string) => String(u).trim()).filter(Boolean), origin);
        
        // Valider at result kan serialiseres til JSON
        try {
          JSON.stringify(result);
        } catch (jsonError) {
          console.error("JSON serialization fejlede for batch:", jsonError);
          return Response.json({ error: "Kunne ikke serialisere batch audit resultat" }, { status: 500 });
        }
        
        return Response.json(result, {
          headers: {
            "Cache-Control": "public, max-age=3600, immutable",
          },
        });
      } catch (batchError) {
        const message = batchError instanceof Error ? batchError.message : String(batchError);
        console.error("Batch audit fejlede:", batchError);
        return Response.json({ error: `Batch audit fejlede: ${message}` }, { status: 500 });
      }
    }
    
    if (!url) {
      return Response.json({ error: "URL mangler" }, { status: 400 });
    }
    
    // Full site audit - brug cache hvis ikke force refresh
    if (fullSite) {
      if (!forceRefresh) {
        try {
          const cached = await loadCachedAudit(url);
          if (cached) {
            return Response.json(cached, {
              headers: {
                "Cache-Control": "public, max-age=3600, immutable",
              },
            });
          }
        } catch (cacheError) {
          // Ignorer cache fejl og fortsæt med normal audit
          console.warn("Cache load fejlede, fortsætter med normal audit:", cacheError);
        }
      }
      
      try {
        const result = await runFullSiteAudit(url);
        
        // Valider at result kan serialiseres til JSON
        try {
          JSON.stringify(result);
        } catch (jsonError) {
          console.error("JSON serialization fejlede:", jsonError);
          return Response.json({ error: "Kunne ikke serialisere audit resultat" }, { status: 500 });
        }
        
        // Gem i cache (ignorer fejl hvis det fejler)
        try {
          await saveCachedAudit(url, result);
        } catch (saveError) {
          console.warn("Cache save fejlede:", saveError);
        }
        
        return Response.json(result, {
          headers: {
            "Cache-Control": "public, max-age=3600, immutable",
          },
        });
      } catch (auditError) {
        const message = auditError instanceof Error ? auditError.message : String(auditError);
        console.error("Full site audit fejlede:", auditError);
        return Response.json({ error: `Full site audit fejlede: ${message}` }, { status: 500 });
      }
    }
    
    // Single page audit (ikke cached)
    try {
      const result = await runAudit(url);
      return Response.json(result, {
        headers: {
          "Cache-Control": "public, max-age=3600, immutable",
        },
      });
    } catch (auditError) {
      const message = auditError instanceof Error ? auditError.message : String(auditError);
      return Response.json({ error: `Single page audit fejlede: ${message}` }, { status: 500 });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return Response.json({ error: `Uventet fejl: ${message}` }, { status: 500 });
  }
}
