import { NextRequest } from "next/server";
import { getUrlsFromSitemap } from "@/lib/sitemap";

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl.searchParams.get("url")?.trim() || "surfmore.dk";
    const forceRefresh = req.nextUrl.searchParams.get("forceRefresh") === "true";
    const origin = url.startsWith("http") ? new URL(url).origin : `https://${url}`;
    const { allUrls, urlsToAudit, totalInSitemap } = await getUrlsFromSitemap(origin, forceRefresh);
    return Response.json({
      urls: allUrls,
      urlsToAudit,
      totalInSitemap,
      cached: !forceRefresh, // Indikerer om data kom fra cache
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const friendly = message.includes("fetch") || message.includes("network")
      ? "Kunne ikke hente sitemap. Tjek at domænet er korrekt og at /sitemap.xml findes."
      : message;
    return Response.json({ error: friendly }, { status: 500 });
  }
}
