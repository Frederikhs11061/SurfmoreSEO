import { NextRequest } from "next/server";
import { getUrlsFromSitemap } from "@/lib/sitemap";

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl.searchParams.get("url")?.trim() || "surfmore.dk";
    const origin = url.startsWith("http") ? new URL(url).origin : `https://${url}`;
    const { allUrls, urlsToAudit, totalInSitemap } = await getUrlsFromSitemap(origin);
    return Response.json({
      urls: allUrls,
      urlsToAudit,
      totalInSitemap,
    });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
