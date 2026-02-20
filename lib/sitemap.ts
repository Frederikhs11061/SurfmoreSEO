/**
 * Hent alle URLs fra hele sitemap (index → alle child sitemaps → loc).
 * Returnerer alle fundne URLs. Frontend auditerer dem i batches.
 * Håndterer rekursive/nested sitemaps korrekt.
 */

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

function isSitemapUrl(url: string): boolean {
  return url.includes("sitemap") && (url.endsWith(".xml") || url.includes("/sitemap"));
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

async function crawlSitemapRecursive(
  sitemapUrl: string,
  origin: string,
  seenUrls: Set<string>,
  seenSitemaps: Set<string>,
  allUrls: string[]
): Promise<void> {
  // Undgå at crawle samme sitemap flere gange
  if (seenSitemaps.has(sitemapUrl)) return;
  seenSitemaps.add(sitemapUrl);

  try {
    const xml = await fetchText(sitemapUrl);
    const locs = extractLocFromXml(xml);
    
    const nestedSitemaps: string[] = [];
    const pageUrls: string[] = [];
    
    // Opdel i sitemaps og URLs
    for (const loc of locs) {
      if (isSitemapUrl(loc)) {
        nestedSitemaps.push(loc);
      } else {
        pageUrls.push(loc);
      }
    }
    
    // Hvis der er nested sitemaps, crawler vi dem først (rekursivt)
    for (const nestedSitemap of nestedSitemaps) {
      await crawlSitemapRecursive(nestedSitemap, origin, seenUrls, seenSitemaps, allUrls);
    }
    
    // Tilføj alle page URLs
    for (const url of pageUrls) {
      if (!seenUrls.has(url) && (url.startsWith(origin) || url.startsWith("http"))) {
        seenUrls.add(url);
        allUrls.push(url);
      }
    }
  } catch (e) {
    console.warn(`Kunne ikke hente sitemap: ${sitemapUrl}`, e);
  }
}

export async function getUrlsFromSitemap(origin: string): Promise<SitemapResult> {
  const indexUrl = `${origin}/sitemap.xml`;
  const allUrls: string[] = [];
  const seenUrls = new Set<string>();
  const seenSitemaps = new Set<string>();

  try {
    await crawlSitemapRecursive(indexUrl, origin, seenUrls, seenSitemaps, allUrls);
  } catch (e) {
    console.warn("Kunne ikke hente sitemap index, bruger kun forsiden", e);
    const home = origin + "/";
    if (!seenUrls.has(home)) {
      allUrls.push(home);
      seenUrls.add(home);
    }
  }

  const unique = Array.from(new Set(allUrls));
  const totalInSitemap = unique.length;
  const home = origin + "/";
  // Forside først, derefter resten (til batch-audit bruger frontend hele listen)
  const ordered = unique.includes(home) ? [home, ...unique.filter((u) => u !== home)] : unique;

  return {
    allUrls: ordered,
    urls: ordered,
    urlsToAudit: ordered,
    totalInSitemap,
  };
}
