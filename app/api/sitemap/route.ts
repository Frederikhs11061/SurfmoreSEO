import { NextRequest } from "next/server";
import { getUrlsFromSitemap } from "@/lib/sitemap";

export const maxDuration = 60; // Max 60 sekunder for sitemap fetch

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl.searchParams.get("url")?.trim() || "surfmore.dk";
    const forceRefresh = req.nextUrl.searchParams.get("forceRefresh") === "true";
    
    if (!url) {
      return Response.json({ error: "URL parameter mangler" }, { status: 400 });
    }
    
    const origin = url.startsWith("http") ? new URL(url).origin : `https://${url}`;
    
    // Tilføj timeout wrapper for at undgå 504 fejl
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Sitemap fetch timeout")), 55000); // 55 sekunder timeout
    });
    
    const sitemapPromise = getUrlsFromSitemap(origin, forceRefresh);
    
    const { allUrls, urlsToAudit, totalInSitemap } = await Promise.race([
      sitemapPromise,
      timeoutPromise,
    ]) as Awaited<ReturnType<typeof getUrlsFromSitemap>>;
    
    return Response.json({
      urls: allUrls,
      urlsToAudit,
      totalInSitemap,
      cached: !forceRefresh, // Indikerer om data kom fra cache
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const friendly = message.includes("fetch") || message.includes("network") || message.includes("timeout")
      ? "Kunne ikke hente sitemap. Tjek at domænet er korrekt og at /sitemap.xml findes."
      : message;
    
    // Returner 500 ved server fejl, 400 ved client fejl
    const status = message.includes("timeout") || message.includes("fetch") ? 504 : 500;
    return Response.json({ error: friendly }, { status });
  }
}
