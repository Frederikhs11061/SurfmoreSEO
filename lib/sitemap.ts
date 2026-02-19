/**
 * Hent URLs fra sitemap (index → child sitemaps → loc).
 * Begrænser antal for at undgå timeout.
 */

const MAX_PAGES = 12;
const FETCH_TIMEOUT = 8000;

async function fetchText(url: string): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
  const res = await fetch(url, {
    headers: { "User-Agent": "SEO-Audit-Bot/1.0" },
    signal: ctrl.signal,
  });
  clearTimeout(t);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function extractLocFromXml(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) locs.push(m[1].trim());
  return locs;
}

export async function getUrlsFromSitemap(origin: string): Promise<string[]> {
  const indexUrl = `${origin}/sitemap.xml`;
  const allUrls: string[] = [];
  const seen = new Set<string>();

  try {
    const indexXml = await fetchText(indexUrl);
    const childSitemaps = extractLocFromXml(indexXml).filter(
      (u) => u.includes("sitemap") && !u.includes("/no/")
    );
    // Prioritér pages sitemap (ofte vigtigere for SEO)
    const pagesFirst = childSitemaps.sort((a, b) => {
      if (a.includes("pages")) return -1;
      if (b.includes("pages")) return 1;
      if (a.includes("products")) return -1;
      return 0;
    });

    for (const sitemapUrl of pagesFirst) {
      if (allUrls.length >= MAX_PAGES) break;
      try {
        const xml = await fetchText(sitemapUrl);
        const urls = extractLocFromXml(xml);
        for (const u of urls) {
          if (!seen.has(u) && (u.startsWith(origin) || u.startsWith("http"))) {
            seen.add(u);
            allUrls.push(u);
            if (allUrls.length >= MAX_PAGES) break;
          }
        }
      } catch {
        // skip denne sitemap
      }
    }

    // Hvis vi mangler, hent fra products/collections
    if (allUrls.length < MAX_PAGES) {
      for (const sitemapUrl of childSitemaps) {
        if (allUrls.length >= MAX_PAGES) break;
        if (sitemapUrl.includes("pages")) continue;
        try {
          const xml = await fetchText(sitemapUrl);
          const urls = extractLocFromXml(xml);
          for (const u of urls) {
            if (!seen.has(u)) {
              seen.add(u);
              allUrls.push(u);
              if (allUrls.length >= MAX_PAGES) break;
            }
          }
        } catch {
          //
        }
      }
    }
  } catch {
    // Ingen sitemap – brug kun homepage
    allUrls.push(origin + "/");
  }

  const unique = Array.from(new Set(allUrls));
  return unique.slice(0, MAX_PAGES);
}
