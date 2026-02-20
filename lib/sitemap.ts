/**
 * Hent alle URLs fra hele sitemap (index → alle child sitemaps → loc).
 * Returnerer alle fundne URLs. Frontend auditerer dem i batches.
 */

const MAX_URLS_TO_RETURN = 50000; // Høj grænse for at dække meget store sites
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
  /** Samme som allUrls – til brug i API/frontend */
  urls: string[];
  /** URLs der skal auditeres (samme som urls ved fuld crawl) */
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
    // Find alle sitemaps (både direkte URLs og child sitemaps)
    const allSitemapUrls = extractLocFromXml(indexXml);
    
    // Hvis der er child sitemaps (indeholder "sitemap" i URL), crawler vi dem
    // Ellers er URLs direkte i index-sitemap
    const childSitemaps = allSitemapUrls.filter(
      (u) => u.includes("sitemap") && !u.includes("/no/")
    );
    
    if (childSitemaps.length > 0) {
      // Crawl alle child sitemaps systematisk
      for (const sitemapUrl of childSitemaps) {
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
        } catch (e) {
          console.warn(`Kunne ikke hente sitemap: ${sitemapUrl}`, e);
        }
      }
    } else {
      // Hvis ingen child sitemaps, så er URLs direkte i index
      for (const u of allSitemapUrls) {
        if (!seen.has(u) && (u.startsWith(origin) || u.startsWith("http"))) {
          seen.add(u);
          allUrls.push(u);
          if (allUrls.length >= MAX_URLS_TO_RETURN) break;
        }
      }
    }
  } catch (e) {
    console.warn("Kunne ikke hente sitemap index, bruger kun forsiden", e);
    allUrls.push(origin + "/");
  }

  const unique = Array.from(new Set(allUrls));
  const totalInSitemap = unique.length;
  const home = origin + "/";
  // Forside først, derefter resten (til batch-audit bruger frontend hele listen)
  const ordered = unique.includes(home) ? [home, ...unique.filter((u) => u !== home)] : unique;

  // Log hvis vi ramte grænsen
  if (allUrls.length >= MAX_URLS_TO_RETURN) {
    console.warn(`⚠️ Sitemap crawl nåede grænsen på ${MAX_URLS_TO_RETURN} URLs. Der kan være flere sider i sitemappen.`);
  }

  return {
    allUrls: ordered,
    urls: ordered,
    urlsToAudit: ordered,
    totalInSitemap,
  };
}
