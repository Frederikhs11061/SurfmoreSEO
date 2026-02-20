/**
 * Cache for audit results - samme struktur som sitemap cache
 */

import { promises as fs } from "fs";
import { join } from "path";
import type { FullSiteResult } from "./audit";

const CACHE_DIR = join(process.cwd(), ".cache");
const CACHE_TTL = 1 * 60 * 60 * 1000; // 1 time - samme som sitemap cache

// In-memory cache for ekstra hurtig adgang (deles mellem alle requests)
const memoryCache = new Map<string, { data: FullSiteResult; cachedAt: number }>();

async function ensureCacheDir() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch {
    // Ignorer fejl hvis dir allerede findes
  }
}

function getCachePath(domain: string): string {
  const safeDomain = domain.replace(/^https?:\/\//, "").replace(/[^a-z0-9]/gi, "_");
  return join(CACHE_DIR, `audit_${safeDomain}.json`);
}

interface CachedAudit {
  data: FullSiteResult;
  cachedAt: number;
}

export async function loadCachedAudit(domain: string): Promise<FullSiteResult | null> {
  // Tjek in-memory cache først (hurtigst)
  const memCached = memoryCache.get(domain);
  if (memCached) {
    const age = Date.now() - memCached.cachedAt;
    if (age <= CACHE_TTL) {
      return memCached.data; // Returner fra memory cache
    } else {
      memoryCache.delete(domain); // Fjern udløbet cache
    }
  }

  // Tjek fil-cache (langsommere, men persistent)
  try {
    await ensureCacheDir();
    const cachePath = getCachePath(domain);
    const data = await fs.readFile(cachePath, "utf-8");
    const cached: CachedAudit = JSON.parse(data);
    
    // Tjek om cache er udløbet
    const age = Date.now() - cached.cachedAt;
    if (age > CACHE_TTL) {
      // Slet udløbet cache fil
      try {
        await fs.unlink(cachePath);
      } catch {
        // Ignorer fejl ved sletning
      }
      return null; // Cache udløbet
    }
    
    // Valider cache data
    if (!cached.data || !cached.data.origin) {
      return null; // Ugyldig cache data
    }
    
    // Gem også i memory cache for hurtigere adgang næste gang (begræns størrelse)
    if (memoryCache.size > 50) {
      // Ryd op i memory cache hvis den bliver for stor
      const oldest = Array.from(memoryCache.entries())
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
      if (oldest) memoryCache.delete(oldest[0]);
    }
    memoryCache.set(domain, { data: cached.data, cachedAt: cached.cachedAt });
    
    return cached.data;
  } catch {
    return null; // Ingen cache eller fejl ved læsning
  }
}

export async function saveCachedAudit(domain: string, result: FullSiteResult): Promise<void> {
  const now = Date.now();
  
  // Valider data før caching
  if (!result || !result.origin) {
    return; // Ikke cache tomme eller ugyldige resultater
  }
  
  // Gem i memory cache (hurtigst, deles mellem alle requests)
  // Begræns størrelse for at undgå memory issues
  if (memoryCache.size > 50) {
    const oldest = Array.from(memoryCache.entries())
      .sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0];
    if (oldest) memoryCache.delete(oldest[0]);
  }
  memoryCache.set(domain, { data: result, cachedAt: now });
  
  // Gem også i fil-cache (persistent, overlever server restarts)
  try {
    await ensureCacheDir();
    const cachePath = getCachePath(domain);
    const cached: CachedAudit = {
      data: result,
      cachedAt: now,
    };
    await fs.writeFile(cachePath, JSON.stringify(cached, null, 2), "utf-8");
  } catch (e) {
    // Ignorer fejl ved fil-caching (ikke kritisk, memory cache virker stadig)
    console.warn("Kunne ikke gemme audit cache:", e);
  }
}
