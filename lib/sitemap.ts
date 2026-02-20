/**
 * Hent alle URLs fra hele sitemap (index → alle child sitemaps → loc).
 * Returnerer alle fundne URLs. Frontend auditerer dem i batches.
 * Håndterer rekursive/nested sitemaps korrekt.
 * Cacher sitemap data til fil for hurtigere genindlæsning.
 */

import { promises as fs } from "fs";
import { join } from "path";

const FETCH_TIMEOUT = 8000;
const CACHE_DIR = join(process.cwd(), ".cache");
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 timer - aggressiv cache

// In-memory cache for ekstra hurtig adgang (deles mellem alle requests)
const memoryCache = new Map<string, { data: SitemapResult; cachedAt: number }>();

async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch {
    // Ignorer fejl hvis dir allerede findes
  }
}

function getCachePath(origin: string): string {
  const domain = origin.replace(/^https?:\/\//, "").replace(/[^a-z0-9]/gi, "_");
  return join(CACHE_DIR, `sitemap_${domain}.json`);
}

interface CachedSitemap {
  urls: string[];
  totalInSitemap: number;
  cachedAt: number;
}

async function loadCachedSitemap(origin: string): Promise<SitemapResult | null> {
  // Tjek in-memory cache først (hurtigst)
  const memCached = memoryCache.get(origin);
  if (memCached) {
    const age = Date.now() - memCached.cachedAt;
    if (age <= CACHE_TTL) {
      return memCached.data; // Returner fra memory cache
    } else {
      memoryCache.delete(origin); // Fjern udløbet cache
    }
  }

  // Tjek fil-cache (langsommere, men persistent)
  try {
    await ensureCacheDir();
    const cachePath = getCachePath(origin);
    const data = await fs.readFile(cachePath, "utf-8");
    const cached: CachedSitemap = JSON.parse(data);
    
    // Tjek om cache er udløbet
    const age = Date.now() - cached.cachedAt;
    if (age > CACHE_TTL) {
      return null; // Cache udløbet
    }
    
    const home = origin + "/";
    const ordered = cached.urls.includes(home) 
      ? [home, ...cached.urls.filter((u) => u !== home)] 
      : cached.urls;
    
    const result: SitemapResult = {
      allUrls: ordered,
      urls: ordered,
      urlsToAudit: ordered,
      totalInSitemap: cached.totalInSitemap,
    };

    // Gem også i memory cache for hurtigere adgang næste gang
    memoryCache.set(origin, { data: result, cachedAt: cached.cachedAt });
    
    return result;
  } catch {
    return null; // Ingen cache eller fejl ved læsning
  }
}

async function saveCachedSitemap(origin: string, result: SitemapResult): Promise<void> {
  const now = Date.now();
  
  // Gem i memory cache (hurtigst, deles mellem alle requests)
  memoryCache.set(origin, { data: result, cachedAt: now });
  
  // Gem også i fil-cache (persistent, overlever server restarts)
  try {
    await ensureCacheDir();
    const cachePath = getCachePath(origin);
    const cached: CachedSitemap = {
      urls: result.allUrls,
      totalInSitemap: result.totalInSitemap,
      cachedAt: now,
    };
    await fs.writeFile(cachePath, JSON.stringify(cached, null, 2), "utf-8");
  } catch {
    // Ignorer fejl ved fil-caching (ikke kritisk, memory cache virker stadig)
  }
}

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

export async function getUrlsFromSitemap(origin: string, forceRefresh: boolean = false): Promise<SitemapResult> {
  // Prøv at hente fra cache først (hvis ikke force refresh)
  if (!forceRefresh) {
    const cached = await loadCachedSitemap(origin);
    if (cached) {
      return cached;
    }
  }

  const indexUrl = `${origin}/sitemap.xml`;
  const allUrls: string[] = [];
  const seenUrls = new Set<string>();
  const seenSitemaps = new Set<string>();

  try {
    // Crawl ALLE sitemaps rekursivt - ingen begrænsning
    await crawlSitemapRecursive(indexUrl, origin, seenUrls, seenSitemaps, allUrls);
    
    // Hvis vi ikke fandt nogen URLs, prøv også alternative sitemap paths
    if (allUrls.length === 0) {
      const alternativePaths = [
        `${origin}/sitemap_index.xml`,
        `${origin}/sitemaps.xml`,
        `${origin}/sitemap1.xml`,
      ];
      
      for (const altPath of alternativePaths) {
        try {
          await crawlSitemapRecursive(altPath, origin, seenUrls, seenSitemaps, allUrls);
        } catch {
          // Ignorer fejl ved alternative paths
        }
      }
    }
  } catch (e) {
    console.warn("Kunne ikke hente sitemap index, bruger kun forsiden", e);
  }

  // Hvis vi stadig ikke har nogen URLs, tilføj forsiden
  if (allUrls.length === 0) {
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

  const result: SitemapResult = {
    allUrls: ordered,
    urls: ordered,
    urlsToAudit: ordered,
    totalInSitemap,
  };

  // Gem i cache (altid gem efter fetch, også ved force refresh)
  await saveCachedSitemap(origin, result);

  return result;
}
