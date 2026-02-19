/**
 * Hent alle URLs fra hele sitemap (index → alle child sitemaps → loc).
 * Returnerer alle fundne URLs + et udpluk til audit (begrænset pga. timeout).
 */

const MAX_URLS_TO_RETURN = 2000;
const MAX_PAGES_TO_AUDIT = 25;
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

export interface SitemapResult {
  /** Alle URLs fra hele sitemappet (op til MAX_URLS_TO_RETURN) */
  allUrls: string[];
  /** Antal URLs der skal auditeres (forside + repræsentativt udpluk) */
  urlsToAudit: string[];
  /** Samlet antal URLs fundet i sitemap */
  totalInSitemap: number;
}

export async function getUrlsFromSitemap(origin: string): Promise<SitemapResult> {
  const indexUrl = `${origin}/sitemap.xml`;
  const allUrls: string[] = [];
  const seen = new Set<string>();

  try {
    const indexXml = await fetchText(indexUrl);
    const childSitemaps = extractLocFromXml(indexXml).filter(
      (u) => u.includes("sitemap") && !u.includes("/no/")
    );
    const pagesFirst = childSitemaps.sort((a, b) => {
      if (a.includes("pages")) return -1;
      if (b.includes("pages")) return 1;
      if (a.includes("collections")) return 1;
      if (a.includes("products")) return -1;
      return 0;
    });

    for (const sitemapUrl of pagesFirst) {
      if (allUrls.length >= MAX_URLS_TO_RETURN) break;
      try {
        const xml = await fetchText(sitemapUrl);
        const urls = extractLocFromXml(xml);
        for (const u of urls) {
          if (!seen.has(u) && (u.startsWith(origin) || u.startsWith("http"))) {
            seen.add(u);
            allUrls.push(u);
            if (allUrls.length >= MAX_URLS_TO_RETURN) break;
          }
        }
      } catch {
        //
      }
    }

    if (allUrls.length < MAX_URLS_TO_RETURN) {
      for (const sitemapUrl of childSitemaps) {
        if (allUrls.length >= MAX_URLS_TO_RETURN) break;
        try {
          const xml = await fetchText(sitemapUrl);
          const urls = extractLocFromXml(xml);
          for (const u of urls) {
            if (!seen.has(u)) {
              seen.add(u);
              allUrls.push(u);
              if (allUrls.length >= MAX_URLS_TO_RETURN) break;
            }
          }
        } catch {
          //
        }
      }
    }
  } catch {
    allUrls.push(origin + "/");
  }

  const unique = Array.from(new Set(allUrls));
  const totalInSitemap = unique.length;

  // Forside først, derefter et blandet udpluk (pages, products, collections)
  const home = origin + "/";
  const withHome = unique.filter((u) => u !== home);
  const toAudit = [home, ...withHome].slice(0, MAX_PAGES_TO_AUDIT);

  return {
    allUrls: unique,
    urlsToAudit: toAudit.length ? toAudit : [home],
    totalInSitemap,
  };
}
