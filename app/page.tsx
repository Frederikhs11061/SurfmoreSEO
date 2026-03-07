"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { AuditResult, AuditIssue, Severity, FullSiteResult, ImprovementSuggestion } from "@/lib/audit";
import { buildSuggestionsFromAggregated } from "@/lib/suggestions";
import { getPillarForCategory, SEO_PILLARS, type SEOPillar } from "@/lib/seoPillars";

const BATCH_SIZE = 50; // Reduceret batch-størrelse for at undgå 'Failed to fetch' netværksfejl
const CONCURRENT_BATCHES = 3; // Reduceret fra 15 til 3 for at undgå connection drops i browseren

function mergeBatchResults(
  batches: FullSiteResult[],
  totalUrlsInSitemap: number,
  origin: string
): FullSiteResult {
  const pages: AuditResult[] = batches.flatMap((b) => b.pages);
  const allIssues: AuditIssue[] = [];
  for (const p of pages) {
    for (const i of p.issues) {
      allIssues.push({ ...i, pageUrl: p.url });
    }
  }
  const byKey = new Map<string, AuditIssue & { pages: string[]; allImages?: string[] }>();
  for (const i of allIssues) {
    const key = `${i.category}|${i.severity}|${i.title}`;
    const existing = byKey.get(key);

    // For billeder uden alt-tekst, saml alle billed-URL'er
    if (i.category === "Billeder" && i.title.includes("alt-tekst") && i.value) {
      const imagesFromIssue = i.value.split(", ").filter(img => img.trim());
      if (existing) {
        if (i.pageUrl && !existing.pages.includes(i.pageUrl)) existing.pages.push(i.pageUrl);
        // Saml alle billeder fra alle sider
        if (!existing.allImages) existing.allImages = [];
        existing.allImages.push(...imagesFromIssue);
      } else {
        byKey.set(key, {
          ...i,
          pages: i.pageUrl ? [i.pageUrl] : [],
          allImages: imagesFromIssue,
        });
      }
    } else {
      // Normal aggregering for andre issues
      if (existing) {
        if (i.pageUrl && !existing.pages.includes(i.pageUrl)) existing.pages.push(i.pageUrl);
      } else {
        byKey.set(key, { ...i, pages: i.pageUrl ? [i.pageUrl] : [] });
      }
    }
  }
  const aggregated: AuditIssue[] = Array.from(byKey.values()).map(({ pages: p, allImages, ...rest }) => {
    // For billeder uden alt-tekst, brug alle samlede billeder i value
    if (rest.category === "Billeder" && rest.title.includes("alt-tekst") && allImages && allImages.length > 0) {
      return {
        ...rest,
        value: allImages.join(", "),
        pageUrl: p.length > 0 ? (p.length === 1 ? p[0] : `${p.length} sider`) : undefined,
        affectedPages: p.length > 0 ? p : undefined,
      };
    }
    return {
      ...rest,
      pageUrl: p.length > 0 ? (p.length === 1 ? p[0] : `${p.length} sider`) : undefined,
      affectedPages: p.length > 0 ? p : undefined,
    };
  });
  const categories: Record<string, { passed: number; failed: number; warnings: number }> = {};
  for (const i of aggregated) {
    if (!categories[i.category]) categories[i.category] = { passed: 0, failed: 0, warnings: 0 };
    if (i.severity === "pass") categories[i.category].passed++;
    else if (i.severity === "error") categories[i.category].failed++;
    else categories[i.category].warnings++;
  }
  const total = aggregated.length;
  const passed = aggregated.filter((i) => i.severity === "pass").length;
  const overallScore = total > 0 ? Math.round((passed / total) * 100) : 0;
  const improvementSuggestions = buildSuggestionsFromAggregated(aggregated);

  // Aggreger EEAT overordnet (over hele sitet) med trust signals metrics
  const allEeatData = pages.map(p => p.eeat).filter((e): e is NonNullable<typeof e> => e !== undefined);
  let aggregatedEeat: FullSiteResult["eeat"] | undefined;
  if (allEeatData.length > 0 || pages.length > 0) {
    // Tjek om sitet overordnet har EEAT-signaler
    const hasAuthor = allEeatData.some(e => e.author);
    const hasAuthorBio = allEeatData.some(e => e.authorBio);
    const hasExpertise = allEeatData.some(e => e.expertise);
    const hasTrustworthiness = allEeatData.some(e => e.trustworthiness);
    const hasAboutPage = allEeatData.some(e => e.aboutPage);
    const hasContactInfo = allEeatData.some(e => e.contactInfo);

    // Find mest almindelige forfatter
    const authors = allEeatData.map(e => e.author).filter((a): a is string => !!a);
    const authorCounts = new Map<string, number>();
    authors.forEach(a => authorCounts.set(a, (authorCounts.get(a) || 0) + 1));
    const mostCommonAuthor = Array.from(authorCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];

    // Beregn trust signals metrics
    const pagesWithAuthor = pages.filter(p => p.eeat?.author).length;
    const pagesWithSchema = pages.filter(p => {
      const schemaIssues = p.issues.filter(i => i.category === "Strukturerede data" && i.severity === "pass");
      return schemaIssues.length > 0;
    }).length;
    const pagesWithOpenGraph = pages.filter(p => {
      const ogIssues = p.issues.filter(i => i.category === "Social (OG)" && i.severity === "pass");
      return ogIssues.length >= 2; // Mindst title og description
    }).length;
    const pagesWithHttps = pages.filter(p => {
      const httpsIssues = p.issues.filter(i => i.category === "Sikkerhed" && i.title === "HTTPS" && i.severity === "pass");
      return httpsIssues.length > 0;
    }).length;
    const pagesWithSufficientContent = pages.filter(p => {
      const contentIssues = p.issues.filter(i => i.category === "Indhold" && (i.title === "Tekstmængde" || i.title === "God tekstmængde"));
      return contentIssues.length > 0;
    }).length;

    // Tæl eksterne links totalt og sider med eksterne links
    let totalExternalLinks = 0;
    pages.forEach(p => {
      const externalLinkIssues = p.issues.filter(i =>
        i.category === "Links & canonical" &&
        (i.title === "Eksterne links" || i.title === "Eksterne links mangler rel-attributter")
      );
      externalLinkIssues.forEach(issue => {
        const match = issue.message.match(/(\d+)\s+eksterne links/);
        if (match) totalExternalLinks += parseInt(match[1], 10);
      });
    });

    const eeatScore = [
      hasAuthor ? 1 : 0,
      hasAuthorBio ? 1 : 0,
      hasExpertise ? 1 : 0,
      hasTrustworthiness ? 1 : 0,
      hasAboutPage ? 1 : 0,
      hasContactInfo ? 1 : 0,
    ].reduce((a, b) => a + b, 0);

    aggregatedEeat = {
      author: mostCommonAuthor,
      authorBio: hasAuthorBio,
      expertise: hasExpertise,
      trustworthiness: hasTrustworthiness,
      aboutPage: hasAboutPage,
      contactInfo: hasContactInfo,
      score: Math.round((eeatScore / 6) * 100),
      pagesWithAuthor,
      pagesWithSchema,
      externalCitations: totalExternalLinks,
      pagesWithOpenGraph,
      pagesWithHttps,
      pagesWithSufficientContent,
    };
  }

  return {
    origin,
    pages,
    aggregated,
    overallScore,
    categories,
    pagesAudited: pages.length,
    totalUrlsInSitemap,
    improvementSuggestions,
    eeat: aggregatedEeat,
  };
}

const severityStyles: Record<Severity, string> = {
  error: "bg-gradient-to-br from-red-50 to-rose-50 text-red-900 border-2 border-red-200 shadow-sm",
  warning: "bg-gradient-to-br from-amber-50 to-orange-50 text-amber-900 border-2 border-amber-200 shadow-sm",
  pass: "bg-gradient-to-br from-emerald-50 to-green-50 text-green-900 border-2 border-green-200 shadow-sm",
};

const severityLabels: Record<Severity, string> = {
  error: "Fejl",
  warning: "Advarsel",
  pass: "OK",
};

function isFullSiteResult(r: AuditResult | FullSiteResult): r is FullSiteResult {
  return "aggregated" in r && "pages" in r;
}

function ImageListComponent({ images }: { images: string }) {
  const [showUrls, setShowUrls] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const imageList = images.split(", ").filter(img => img.trim());

  // Fjern duplikater baseret på URL uden query params
  const uniqueImages = new Map<string, string>();
  imageList.forEach(img => {
    try {
      const url = new URL(img);
      const baseUrl = `${url.origin}${url.pathname}`;
      if (!uniqueImages.has(baseUrl)) {
        uniqueImages.set(baseUrl, img); // Gem original URL med params
      }
    } catch {
      // Hvis URL parsing fejler, brug original
      if (!uniqueImages.has(img)) {
        uniqueImages.set(img, img);
      }
    }
  });

  const uniqueUrls = Array.from(uniqueImages.values());

  // Filtrer baseret på søgning
  const filteredUrls = uniqueUrls.filter(img => {
    if (!searchQuery.trim()) return true;
    const query = searchQuery.toLowerCase();
    try {
      const url = new URL(img);
      const filename = url.pathname.split("/").pop() || url.pathname;
      return filename.toLowerCase().includes(query) || img.toLowerCase().includes(query);
    } catch {
      return img.toLowerCase().includes(query);
    }
  });

  return (
    <div className="mt-1">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-slate-700">
          {uniqueUrls.length} unikke billeder uden alt-tekst
        </span>
        <button
          onClick={() => setShowUrls(!showUrls)}
          className="text-xs text-blue-600 hover:text-blue-800 hover:underline font-medium bg-blue-50 px-2 py-1 rounded"
        >
          {showUrls ? "Skjul URLs" : "Se URLs"}
        </button>
      </div>

      {showUrls && (
        <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
          <div className="mb-2">
            <input
              type="search"
              placeholder="Søg efter filnavn eller URL..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded border border-slate-300 px-3 py-1.5 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            <ul className="space-y-1">
              {filteredUrls.length === 0 ? (
                <li className="text-xs text-slate-500 italic">Ingen resultater matcher søgningen</li>
              ) : (
                filteredUrls.map((img, idx) => {
                  try {
                    const url = new URL(img);
                    const filename = url.pathname.split("/").pop() || url.pathname;
                    return (
                      <li key={idx} className="flex items-center gap-2">
                        <span className="text-slate-400">•</span>
                        <a
                          href={img}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-800 hover:underline break-all text-xs"
                          title={img}
                        >
                          {filename}
                        </a>
                        <span className="text-slate-400 text-xs">({img})</span>
                      </li>
                    );
                  } catch {
                    return (
                      <li key={idx} className="flex items-center gap-2">
                        <span className="text-slate-400">•</span>
                        <a
                          href={img}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-800 hover:underline break-all text-xs"
                        >
                          {img}
                        </a>
                      </li>
                    );
                  }
                })
              )}
            </ul>
          </div>
          {filteredUrls.length > 0 && (
            <div className="mt-2 text-xs text-slate-500">
              Viser {filteredUrls.length} af {uniqueUrls.length} billeder
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SEOAuditPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [url, setUrl] = useState("surfmore.dk");
  const [fullSite, setFullSite] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | FullSiteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [tab, setTab] = useState<"overview" | "suggestions" | "issues" | "pages" | "eeat" | "links" | "speed">("overview");
  const [progress, setProgress] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortPagesBy, setSortPagesBy] = useState<"score-asc" | "score-desc" | "url" | "category">("score-asc");
  const [pillarFilter, setPillarFilter] = useState<string>("all");
  const [pageNum, setPageNum] = useState(1);
  const [suggestionsPageNum, setSuggestionsPageNum] = useState(1);
  const [overviewPageNum, setOverviewPageNum] = useState(1);
  const ITEMS_PER_PAGE = 25;
  const [selectedIssue, setSelectedIssue] = useState<AuditIssue | null>(null);
  const [issueSearchQuery, setIssueSearchQuery] = useState("");
  const [issueSortBy, setIssueSortBy] = useState<"severity" | "category" | "title" | "pages">("severity");

  useEffect(() => {
    const pillar = searchParams.get("pillar");
    if (pillar && SEO_PILLARS.includes(pillar as SEOPillar)) {
      setPillarFilter(pillar);
      setTab("overview");
    }
  }, [searchParams]);

  // Load gemt resultat fra localStorage ved mount og når URL ændres
  useEffect(() => {
    const saved = localStorage.getItem(`seo-audit-${url}`);
    if (saved && !result) {
      try {
        const parsed = JSON.parse(saved);
        // Hvis det er essentialData (mangler pages), så brug det stadig
        setResult(parsed);
      } catch {
        // Ignorer hvis parsing fejler
      }
    }
  }, [url, result]);

  // Gem resultat når det ændres (også ved tab skift)
  useEffect(() => {
    if (result && isFullSiteResult(result)) {
      const domain = url.trim();
      try {
        // Gem kun essential data for at undgå quota issues
        const essentialData = {
          origin: result.origin,
          overallScore: result.overallScore,
          categories: result.categories,
          pagesAudited: result.pagesAudited,
          totalUrlsInSitemap: result.totalUrlsInSitemap,
          aggregated: result.aggregated,
          improvementSuggestions: result.improvementSuggestions,
          eeat: result.eeat,
        };
        localStorage.setItem(`seo-audit-${domain}`, JSON.stringify(essentialData));
      } catch {
        // Ignorer hvis det fejler
      }
    }
  }, [result, url]);

  // Fjernet auto-start - sitemap fetches kun når brugeren trykker på knappen

  const run = async (forceRefresh: boolean = false) => {
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress("Henter sitemap…");
    const domain = (url || "surfmore.dk").trim();
    const origin = domain.startsWith("http") ? new URL(domain).origin : `https://${domain}`;
    try {
      if (fullSite) {
        // Tjek først om audit er cached
        if (!forceRefresh) {
          try {
            const cachedAuditRes = await fetch("/api/audit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: domain, fullSite: true, forceRefresh: false }),
            });
            if (cachedAuditRes.ok) {
              const cachedData = await cachedAuditRes.json().catch(() => null);
              if (cachedData && !cachedData.error) {
                setResult(cachedData);
                setLoading(false);
                setProgress(null);
                return; // Brug cached resultat
              }
            }
          } catch (cacheError) {
            // Ignorer cache fejl og fortsæt med normal audit
            console.warn("Cache check fejlede, fortsætter med normal audit:", cacheError);
          }
        }

        let sitemapRes: Response;
        try {
          const sitemapUrl = `/api/sitemap?url=${encodeURIComponent(domain)}${forceRefresh ? "&forceRefresh=true" : ""}`;
          console.log("Fetching sitemap:", sitemapUrl);
          sitemapRes = await fetch(sitemapUrl, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
          });
          console.log("Sitemap response status:", sitemapRes.status, sitemapRes.ok);
        } catch (fetchError) {
          console.error("Sitemap fetch error:", fetchError);
          throw new Error(`Kunne ikke hente sitemap: ${fetchError instanceof Error ? fetchError.message : "Network error"}`);
        }
        let sitemapData: any = {};
        try {
          sitemapData = await sitemapRes.json();
        } catch (jsonError) {
          console.error("Sitemap JSON parse error:", jsonError);
          const text = await sitemapRes.text().catch(() => "Kunne ikke læse response");
          throw new Error(`Kunne ikke parse sitemap response: ${text.substring(0, 200)}`);
        }
        if (!sitemapRes.ok) {
          console.error("Sitemap response not OK:", sitemapRes.status, sitemapData);
          throw new Error(sitemapData?.error || `Kunne ikke hente sitemap (${sitemapRes.status})`);
        }
        const rawUrls = sitemapData.urls ?? sitemapData.urlsToAudit ?? sitemapData.allUrls;
        const allUrls: string[] = Array.isArray(rawUrls) ? rawUrls : [];
        const totalInSitemap = typeof sitemapData.totalInSitemap === "number" ? sitemapData.totalInSitemap : allUrls.length;
        setProgress(`Sitemap: ${allUrls.length} URLs. Starter audit…`);
        if (allUrls.length === 0) {
          let fallback: Response;
          try {
            fallback = await fetch("/api/audit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: domain, fullSite: true, forceRefresh }),
            });
          } catch (fetchError) {
            throw new Error(`Kunne ikke hente audit: ${fetchError instanceof Error ? fetchError.message : "Network error"}`);
          }
          const fallbackData = await fallback.json().catch(() => ({}));
          if (!fallback.ok) throw new Error(fallbackData?.error || `Audit fejlede (${fallback.status})`);
          if (fallbackData?.error) throw new Error(fallbackData.error);
          setResult(fallbackData);
        } else {
          const batches: FullSiteResult[] = [];
          const totalBatches = Math.ceil(allUrls.length / BATCH_SIZE);
          const chunks: string[][] = [];
          // Opdel ALLE URLs i batches - ingen begrænsning, alle URLs bliver auditeret
          for (let i = 0; i < allUrls.length; i += BATCH_SIZE) {
            chunks.push(allUrls.slice(i, i + BATCH_SIZE));
          }

          // Initialiser resultat med tom struktur for at undgå layout shift
          const initialResult: FullSiteResult = {
            origin,
            pages: [],
            aggregated: [],
            overallScore: 0,
            categories: {},
            pagesAudited: 0,
            totalUrlsInSitemap: totalInSitemap,
            improvementSuggestions: [],
          };
          setResult(initialResult);

          // Kør batches parallelt i grupper af CONCURRENT_BATCHES og opdater sideløbende
          for (let i = 0; i < chunks.length; i += CONCURRENT_BATCHES) {
            const group = chunks.slice(i, i + CONCURRENT_BATCHES);
            const batchStart = i + 1;
            const batchEnd = Math.min(i + CONCURRENT_BATCHES, chunks.length);
            setProgress(`Auditerer batches ${batchStart}–${batchEnd} af ${totalBatches} (${allUrls.length} sider totalt)…`);

            // Kør batches parallelt client-side hvor muligt, ellers brug API
            const groupPromises = group.map(async (chunk, idx) => {
              const batchNum = i + idx + 1;

              // Prøv client-side audit først (hurtigere, ingen server load)
              try {
                const { runBatchAuditClient } = await import("@/lib/auditClient");
                const clientResults = await Promise.all(
                  chunk.map(url => runBatchAuditClient(url, origin))
                );
                const validResults = clientResults.filter((r): r is NonNullable<typeof r> => r !== null);

                if (validResults.length > 0) {
                  // Merge client-side results til samme format som server-side
                  return {
                    origin,
                    pages: validResults,
                    aggregated: [],
                    overallScore: 0,
                    categories: {},
                    pagesAudited: validResults.length,
                    totalUrlsInSitemap: chunk.length,
                    improvementSuggestions: [],
                  };
                }
              } catch (e) {
                // Hvis client-side fejler (fx CORS), fal tilbage til server-side
                console.warn(`Client-side audit fejlede for batch ${batchNum}, bruger server-side:`, e);
              }

              // Fallback til server-side audit
              let res: Response;
              try {
                res = await fetch("/api/audit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ urlBatch: chunk, origin, forceRefresh }),
                });
              } catch (fetchError) {
                throw new Error(`Batch ${batchNum} fetch fejlede: ${fetchError instanceof Error ? fetchError.message : "Network error"}`);
              }
              const data = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(data?.error || `Batch ${batchNum} fejlede (${res.status})`);
              if (data?.error) throw new Error(`Batch ${batchNum}: ${data.error}`);
              return data;
            });

            // Vent på alle batches i gruppen og opdater resultatet sideløbende
            const groupResults = await Promise.all(groupPromises);
            batches.push(...groupResults);

            // Opdater resultatet med det samme for at undgå reflow
            const currentMerged = mergeBatchResults(batches, totalInSitemap, origin);
            setResult(currentMerged);
          }

          setProgress("Færdig!");
          // Final merge for at sikre alt er korrekt
          const finalMerged = mergeBatchResults(batches, totalInSitemap, origin);
          setResult(finalMerged);
          // Gem kun essentiell data i localStorage (ikke alle pages for at undgå quota)
          try {
            const essentialData = {
              origin: finalMerged.origin,
              overallScore: finalMerged.overallScore,
              categories: finalMerged.categories,
              pagesAudited: finalMerged.pagesAudited,
              totalUrlsInSitemap: finalMerged.totalUrlsInSitemap,
              aggregated: finalMerged.aggregated,
              improvementSuggestions: finalMerged.improvementSuggestions,
            };
            localStorage.setItem(`seo-audit-${domain}`, JSON.stringify(essentialData));
          } catch (e) {
            // Hvis localStorage stadig fejler, prøv at rydde gamle entries
            try {
              const keys = Object.keys(localStorage);
              const oldKeys = keys.filter(k => k.startsWith('seo-audit-'));
              oldKeys.forEach(k => localStorage.removeItem(k));
              const essentialData = {
                origin: finalMerged.origin,
                overallScore: finalMerged.overallScore,
                categories: finalMerged.categories,
                pagesAudited: finalMerged.pagesAudited,
                totalUrlsInSitemap: finalMerged.totalUrlsInSitemap,
                aggregated: finalMerged.aggregated,
                improvementSuggestions: finalMerged.improvementSuggestions,
              };
              localStorage.setItem(`seo-audit-${domain}`, JSON.stringify(essentialData));
            } catch {
              // Ignorer hvis det stadig fejler
            }
          }
        }
      } else {
        let res: Response;
        try {
          res = await fetch("/api/audit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: domain, fullSite: false }),
          });
        } catch (fetchError) {
          throw new Error(`Kunne ikke hente audit: ${fetchError instanceof Error ? fetchError.message : "Network error"}`);
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || `Audit fejlede (${res.status})`);
        if (data?.error) throw new Error(data.error);
        setResult(data);
        // Gem også single-page resultat (kun essentiell data)
        try {
          const essentialData = {
            url: data.url,
            score: data.score,
            categories: data.categories,
            issues: data.issues,
          };
          localStorage.setItem(`seo-audit-${domain}`, JSON.stringify(essentialData));
        } catch {
          // Ignorer hvis localStorage fejler
        }
      }
      setTab("overview");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const errorMessage = message.includes("Failed to fetch")
        ? `Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse og prøv igen. Detaljer: ${message}`
        : message || "Noget gik galt";
      setError(errorMessage);
      console.error("SEO Audit error:", e);
      if (e instanceof TypeError && e.message.includes("fetch")) {
        console.error("Fetch fejl detaljer:", {
          message: e.message,
          stack: e.stack,
        });
      }
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const full = result && isFullSiteResult(result) ? result : null;
  const single = result && !isFullSiteResult(result) ? result : null;

  const issues: AuditIssue[] = full ? (full.aggregated ?? []) : single ? (single.issues ?? []) : [];
  const byPillar = (iss: AuditIssue[]) => {
    if (pillarFilter === "all") return iss;
    return iss.filter((i) => getPillarForCategory(i.category) === pillarFilter);
  };
  const bySeverity =
    filter === "all" ? (iss: AuditIssue[]) => iss : (iss: AuditIssue[]) => iss.filter((i) => i.severity === filter);
  const filteredIssues = bySeverity(byPillar(issues));

  // Søg og sorter issues
  const issueSearchLower = issueSearchQuery.trim().toLowerCase();
  const searchedIssues = issueSearchLower === ""
    ? filteredIssues
    : filteredIssues.filter(
      (i) =>
        i.title.toLowerCase().includes(issueSearchLower) ||
        i.category.toLowerCase().includes(issueSearchLower) ||
        i.message.toLowerCase().includes(issueSearchLower) ||
        (i.affectedPages && i.affectedPages.some((p) => p.toLowerCase().includes(issueSearchLower)))
    );

  const sortedIssues = [...searchedIssues].sort((a, b) => {
    if (issueSortBy === "severity") {
      const order: Record<Severity, number> = { error: 0, warning: 1, pass: 2 };
      return order[a.severity] - order[b.severity];
    }
    if (issueSortBy === "category") return a.category.localeCompare(b.category);
    if (issueSortBy === "title") return a.title.localeCompare(b.title);
    if (issueSortBy === "pages") {
      const aPages = a.affectedPages?.length ?? (a.pageUrl?.includes(" sider") ? parseInt(a.pageUrl) : 1);
      const bPages = b.affectedPages?.length ?? (b.pageUrl?.includes(" sider") ? parseInt(b.pageUrl) : 1);
      return bPages - aPages; // Flest sider først
    }
    return 0;
  });

  const filtered = sortedIssues;
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const passed = issues.filter((i) => i.severity === "pass").length;
  const score = full ? (full.overallScore ?? 0) : single ? (single.score ?? 0) : 0;
  const categories: Record<string, { passed: number; failed: number; warnings: number }> =
    (full ? full.categories : single ? single.categories : undefined) ?? {};

  // Byg kategorier baseret på faktiske sider, ikke issues
  const pillarCategories: Record<SEOPillar, Record<string, { passed: number; failed: number; warnings: number; totalPages: number }>> = {
    "Teknisk SEO": {},
    "On-page SEO": {},
    "Links": {},
  };

  if (full?.pages) {
    // Tæl faktiske sider pr. kategori og severity
    for (const page of full.pages) {
      const categoryCounts = new Map<string, { passed: number; failed: number; warnings: number }>();

      // Tæl issues pr. kategori på denne side
      for (const issue of page.issues) {
        if (!categoryCounts.has(issue.category)) {
          categoryCounts.set(issue.category, { passed: 0, failed: 0, warnings: 0 });
        }
        const counts = categoryCounts.get(issue.category)!;
        if (issue.severity === "pass") counts.passed++;
        else if (issue.severity === "error") counts.failed++;
        else counts.warnings++;
      }

      // Opdater pillarCategories med denne sides counts
      for (const [cat, counts] of Array.from(categoryCounts.entries())) {
        const pillar = getPillarForCategory(cat);
        if (!pillarCategories[pillar][cat]) {
          pillarCategories[pillar][cat] = { passed: 0, failed: 0, warnings: 0, totalPages: 0 };
        }
        pillarCategories[pillar][cat].passed += counts.passed;
        pillarCategories[pillar][cat].failed += counts.failed;
        pillarCategories[pillar][cat].warnings += counts.warnings;
        pillarCategories[pillar][cat].totalPages++; // Én side har denne kategori
      }
    }
  } else {
    // Fallback til gammel metode hvis ingen pages
    for (const [name, c] of Object.entries(categories)) {
      const pillar = getPillarForCategory(name);
      pillarCategories[pillar][name] = { ...c, totalPages: full?.pagesAudited ?? 0 };
    }
  }

  const pageCategory = (pageUrl: string): string => {
    try {
      const path = new URL(pageUrl).pathname.toLowerCase();
      if (path.includes("/products/")) return "Produkter";
      if (path.includes("/collections/")) return "Kollektioner";
      if (path.includes("/pages/") || path === "/") return "Sider";
      return "Andet";
    } catch {
      return "Andet";
    }
  };
  const filteredPages = Array.isArray(full?.pages) ? full.pages : [];
  const searchLower = searchQuery.trim().toLowerCase();
  const searchedPages =
    searchLower === ""
      ? filteredPages
      : filteredPages.filter(
        (p) =>
          (p?.url ?? "").toLowerCase().includes(searchLower) ||
          pageCategory(p?.url ?? "").toLowerCase().includes(searchLower)
      );
  const sortedPages = [...searchedPages].sort((a, b) => {
    const scoreA = typeof a?.score === "number" ? a.score : 0;
    const scoreB = typeof b?.score === "number" ? b.score : 0;
    const urlA = a?.url ?? "";
    const urlB = b?.url ?? "";
    if (sortPagesBy === "score-asc") return scoreA - scoreB;
    if (sortPagesBy === "score-desc") return scoreB - scoreA;
    if (sortPagesBy === "url") return urlA.localeCompare(urlB);
    return pageCategory(urlA).localeCompare(pageCategory(urlB)) || urlA.localeCompare(urlB);
  });

  const totalPages = Math.ceil(sortedPages.length / ITEMS_PER_PAGE);
  const startIdx = (pageNum - 1) * ITEMS_PER_PAGE;
  const endIdx = startIdx + ITEMS_PER_PAGE;
  const paginatedPages = sortedPages.slice(startIdx, endIdx);

  useEffect(() => {
    if (pageNum > totalPages && totalPages > 0) setPageNum(1);
  }, [totalPages, pageNum]);

  const suggestionsFilteredByPillar =
    full?.improvementSuggestions && pillarFilter !== "all"
      ? full.improvementSuggestions.filter((s) => getPillarForCategory(s.category) === pillarFilter)
      : full?.improvementSuggestions ?? [];
  const suggestionsToShow = pillarFilter === "all" ? (full?.improvementSuggestions ?? []) : suggestionsFilteredByPillar;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-8 rounded-2xl bg-gradient-to-r from-sky-600 via-blue-600 to-cyan-600 p-8 text-white shadow-xl">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-white/20 backdrop-blur-sm">
            <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h1 className="text-3xl font-bold md:text-4xl">
              SEO Audit Tool
            </h1>
            <p className="mt-1 text-blue-100">
              Analyser hele dit site – titel, meta, overskrifter, billeder, mobil, social, crawl og meget mere
            </p>
          </div>
        </div>
      </div>

      <div className="mb-8 rounded-xl bg-white p-6 shadow-lg">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-slate-700">URL / domæne</span>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="surfmore.dk"
              className="w-64 rounded-lg border-2 border-slate-200 px-4 py-2.5 transition focus:border-sky-500 focus:outline-none focus:ring-2 focus:ring-sky-200"
            />
          </label>
          <label className="flex items-center gap-2 rounded-lg border-2 border-slate-200 px-4 py-2.5 transition hover:border-sky-300">
            <input
              type="checkbox"
              checked={fullSite}
              onChange={(e) => setFullSite(e.target.checked)}
              className="h-4 w-4 rounded border-slate-300 text-sky-600 focus:ring-2 focus:ring-sky-500"
            />
            <span className="text-sm font-medium text-slate-700">Hele sitet (crawler sitemap, auditerer alle sider i batches)</span>
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => run(false)}
              disabled={loading}
              className="rounded-lg bg-gradient-to-r from-sky-600 to-blue-600 px-6 py-2.5 font-semibold text-white shadow-md transition hover:from-sky-700 hover:to-blue-700 hover:shadow-lg disabled:opacity-50 disabled:hover:shadow-md"
            >
              {loading ? (progress || (fullSite ? "Henter sitemap…" : "Kører audit…")) : "🚀 Kør audit"}
            </button>
            {fullSite && (
              <button
                type="button"
                onClick={() => run(true)}
                disabled={loading}
                className="rounded-lg bg-gradient-to-r from-amber-500 to-orange-600 px-4 py-2.5 text-sm font-semibold text-white shadow-md transition hover:from-amber-600 hover:to-orange-700 hover:shadow-lg disabled:opacity-50 disabled:hover:shadow-md"
                title="Opdater sitemap cache (ignorerer 4 timers cache)"
              >
                🔄 Opdater cache
              </button>
            )}
          </div>
        </div>
      </div>

      {loading && progress && (
        <div className="mb-4 rounded-lg bg-blue-50 border-2 border-blue-200 p-4">
          <p className="text-sm font-medium text-blue-800">{progress}</p>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg bg-red-50 border-2 border-red-200 p-4 text-red-800">
          <p className="font-semibold">⚠️ Fejl</p>
          <p className="mt-1 text-sm">{error}</p>
        </div>
      )}

      {result && (
        <>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 p-6 text-white shadow-lg">
              <div className="text-3xl font-bold">{score}%</div>
              <div className="mt-1 text-sm font-medium text-blue-100">Score</div>
            </div>
            <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 p-6 text-white shadow-lg">
              <div className="text-3xl font-bold">{passed}</div>
              <div className="mt-1 text-sm font-medium text-green-100">OK</div>
            </div>
            <div className="rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 p-6 text-white shadow-lg">
              <div className="text-3xl font-bold">{warnings}</div>
              <div className="mt-1 text-sm font-medium text-orange-100">Advarsler</div>
            </div>
            <div className="rounded-xl bg-gradient-to-br from-red-500 to-rose-600 p-6 text-white shadow-lg">
              <div className="text-3xl font-bold">{errors}</div>
              <div className="mt-1 text-sm font-medium text-rose-100">Fejl</div>
            </div>
          </div>

          {full && (
            <p className="mt-2 text-sm text-slate-500">
              Sitemap: {full.totalUrlsInSitemap ?? 0} URLs fundet. Auditeret: {full.origin} – {full.pagesAudited} sider.
            </p>
          )}
          {single && (
            <p className="mt-2 text-sm text-slate-500">
              Auditeret: {single.url}
            </p>
          )}

          {full && (
            <>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-slate-600">SEO-pille:</span>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setPillarFilter("all");
                      router.push("/");
                    }}
                    className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${pillarFilter === "all" ? "bg-gradient-to-r from-sky-600 to-blue-600 text-white shadow-md" : "bg-white text-slate-600 shadow-sm hover:bg-slate-50"}`}
                  >
                    Alle
                  </button>
                  {SEO_PILLARS.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => {
                        setPillarFilter(p);
                        setTab("issues");
                        router.push(`?pillar=${encodeURIComponent(p)}`);
                      }}
                      className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${pillarFilter === p ? "bg-gradient-to-r from-sky-600 to-blue-600 text-white shadow-md" : "bg-white text-slate-600 shadow-sm hover:bg-slate-50"}`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
                {pillarFilter !== "all" && (
                  <span className="text-sm text-slate-500">
                    Viser kun: {pillarFilter}
                  </span>
                )}
              </div>
              <div className="mt-6 flex flex-wrap gap-2 border-b border-slate-200">
                <button
                  type="button"
                  onClick={() => setTab("overview")}
                  className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === "overview" ? "border-slate-800 text-slate-800" : "border-transparent text-slate-500"}`}
                >
                  Overblik
                </button>
                <button
                  type="button"
                  onClick={() => setTab("suggestions")}
                  className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === "suggestions" ? "border-slate-800 text-slate-800" : "border-transparent text-slate-500"}`}
                >
                  Forbedringsforslag
                </button>
                <button
                  type="button"
                  onClick={() => setTab("issues")}
                  className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === "issues" ? "border-slate-800 text-slate-800" : "border-transparent text-slate-500"}`}
                >
                  Alle fund
                </button>
                <button
                  type="button"
                  onClick={() => setTab("pages")}
                  className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === "pages" ? "border-slate-800 text-slate-800" : "border-transparent text-slate-500"}`}
                >
                  Pr. side
                </button>
                <button
                  type="button"
                  onClick={() => setTab("eeat")}
                  className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === "eeat" ? "border-slate-800 text-slate-800" : "border-transparent text-slate-500"}`}
                >
                  EEAT
                </button>
                <button
                  type="button"
                  onClick={() => setTab("links")}
                  className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === "links" ? "border-slate-800 text-slate-800" : "border-transparent text-slate-500"}`}
                >
                  Links
                </button>
                <button
                  type="button"
                  onClick={() => setTab("speed")}
                  className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === "speed" ? "border-slate-800 text-slate-800" : "border-transparent text-slate-500"}`}
                >
                  Site Speed
                </button>
              </div>
            </>
          )}

          {tab === "suggestions" && full && (
            <div className="mt-6 space-y-4">
              <h2 className="text-lg font-semibold text-slate-800">Forbedringsforslag</h2>
              <p className="text-sm text-slate-600">
                Konkrete skridt for at rette fejl og advarsler. {pillarFilter !== "all" && `Filtreret: ${pillarFilter}.`} Sorteret efter alvorlighed (fejl først).
              </p>
              {(() => {
                // Vis alle fejl og advarsler, ikke kun suggestions
                const allIssuesForSuggestions = filtered.filter((i: AuditIssue) => i.severity !== "pass");
                const sortedSuggestions = [...allIssuesForSuggestions].sort((a, b) => {
                  if (a.severity === "error" && b.severity !== "error") return -1;
                  if (b.severity === "error" && a.severity !== "error") return 1;
                  return 0;
                });
                const totalSuggestionsPages = Math.ceil(sortedSuggestions.length / ITEMS_PER_PAGE);
                const suggestionsStartIdx = (suggestionsPageNum - 1) * ITEMS_PER_PAGE;
                const suggestionsEndIdx = suggestionsStartIdx + ITEMS_PER_PAGE;
                const paginatedSuggestions = sortedSuggestions.slice(suggestionsStartIdx, suggestionsEndIdx);

                return (
                  <>
                    <div className="space-y-4">
                      {paginatedSuggestions.map((issue: AuditIssue) => {
                        const affectedCount = issue.affectedPages?.length ?? (issue.pageUrl?.includes(" sider") ? parseInt(issue.pageUrl) : (issue.pageUrl ? 1 : 0));
                        return (
                          <div
                            key={issue.id}
                            className={`rounded-xl border-2 p-5 transition-all hover:shadow-lg ${issue.severity === "error" ? "bg-gradient-to-br from-red-50 to-rose-50 border-red-200" : "bg-gradient-to-br from-amber-50 to-orange-50 border-amber-200"}`}
                          >
                            <div className="flex flex-wrap items-center gap-2">
                              <span className={`rounded-lg px-2 py-0.5 text-xs font-semibold uppercase ${issue.severity === "error" ? "bg-red-200 text-red-800" : "bg-amber-200 text-amber-800"}`}>
                                {issue.severity === "error" ? "Fejl" : "Advarsel"}
                              </span>
                              <span className="text-sm font-medium text-slate-600">{issue.category}</span>
                              {affectedCount > 0 && (
                                <span className="text-xs font-medium text-slate-700">
                                  {affectedCount} side{affectedCount !== 1 ? "r" : ""} berørt
                                </span>
                              )}
                            </div>
                            <h3 className="mt-2 text-lg font-bold text-slate-800">{issue.title}</h3>
                            <p className="mt-1 text-sm text-slate-700">{issue.message}</p>
                            {issue.recommendation && (
                              <div className="mt-3 rounded-lg bg-gradient-to-r from-sky-50 to-blue-50 border-2 border-sky-200 p-3">
                                <p className="text-sm font-semibold text-sky-900">💡 Anbefaling:</p>
                                <p className="mt-1 text-sm text-slate-700">{issue.recommendation}</p>
                              </div>
                            )}
                            {issue.value && (
                              <div className="mt-3 rounded-lg bg-white/50 px-3 py-2 text-xs">
                                <p className="break-all">{issue.value}</p>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {totalSuggestionsPages > 1 && (
                      <div className="mt-6 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setSuggestionsPageNum(Math.max(1, suggestionsPageNum - 1))}
                          disabled={suggestionsPageNum === 1}
                          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
                        >
                          ← Forrige
                        </button>
                        <span className="text-sm text-slate-600">
                          Side {suggestionsPageNum} af {totalSuggestionsPages} ({sortedSuggestions.length} forslag totalt)
                        </span>
                        <button
                          type="button"
                          onClick={() => setSuggestionsPageNum(Math.min(totalSuggestionsPages, suggestionsPageNum + 1))}
                          disabled={suggestionsPageNum === totalSuggestionsPages}
                          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
                        >
                          Næste →
                        </button>
                      </div>
                    )}
                    {sortedSuggestions.length === 0 && (
                      <p className="text-center text-slate-500">Ingen fejl eller advarsler at vise.</p>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {tab === "overview" && full && Object.keys(categories).length > 0 && (
            <div className="mt-6 space-y-6">
              <h2 className="text-lg font-semibold text-slate-800">
                Score pr. SEO-pille og kategori
                {pillarFilter !== "all" && ` (${pillarFilter})`}
              </h2>
              {(() => {
                const allPillars = (pillarFilter === "all" ? SEO_PILLARS : [pillarFilter as SEOPillar]);
                const allEntries: Array<{ pillar: SEOPillar; name: string; c: any }> = [];
                allPillars.forEach((pillar) => {
                  const cats = pillarCategories[pillar];
                  Object.entries(cats).forEach(([name, c]) => {
                    allEntries.push({ pillar, name, c });
                  });
                });
                const totalOverviewPages = Math.ceil(allEntries.length / ITEMS_PER_PAGE);
                const overviewStartIdx = (overviewPageNum - 1) * ITEMS_PER_PAGE;
                const overviewEndIdx = overviewStartIdx + ITEMS_PER_PAGE;
                const paginatedEntries = allEntries.slice(overviewStartIdx, overviewEndIdx);

                return (
                  <>
                    {paginatedEntries.map(({ pillar, name, c }) => {
                      const total = c.passed + c.failed + c.warnings;
                      const pct = total > 0 ? Math.round((c.passed / total) * 100) : 0;
                      return (
                        <div key={`${pillar}-${name}`} className="rounded-lg border-2 border-slate-200 bg-white p-4 shadow-sm">
                          <div className="mb-1 text-xs font-medium text-slate-500">{pillar}</div>
                          <div className="flex justify-between">
                            <span className="font-semibold text-slate-700">{name}</span>
                            <span className="font-medium text-slate-500">{pct}%</span>
                          </div>
                          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-600"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <p className="mt-1 text-xs text-slate-500">
                            {c.totalPages} side{c.totalPages !== 1 ? "r" : ""} · {c.passed} OK, {c.warnings} advarsler, {c.failed} fejl
                          </p>
                        </div>
                      );
                    })}
                    {totalOverviewPages > 1 && (
                      <div className="mt-6 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setOverviewPageNum(Math.max(1, overviewPageNum - 1))}
                          disabled={overviewPageNum === 1}
                          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
                        >
                          ← Forrige
                        </button>
                        <span className="text-sm text-slate-600">
                          Side {overviewPageNum} af {totalOverviewPages} ({allEntries.length} kategorier totalt)
                        </span>
                        <button
                          type="button"
                          onClick={() => setOverviewPageNum(Math.min(totalOverviewPages, overviewPageNum + 1))}
                          disabled={overviewPageNum === totalOverviewPages}
                          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50"
                        >
                          Næste →
                        </button>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {(tab === "issues" || !full) && (
            <>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setFilter("all")}
                    className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${filter === "all" ? "bg-gradient-to-r from-sky-600 to-blue-600 text-white shadow-md" : "bg-white text-slate-700 shadow-sm hover:bg-slate-50"}`}
                  >
                    Alle ({issues.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter("error")}
                    className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${filter === "error" ? "bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-md" : "bg-white text-red-700 shadow-sm hover:bg-red-50"}`}
                  >
                    Fejl ({errors})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter("warning")}
                    className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${filter === "warning" ? "bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-md" : "bg-white text-amber-700 shadow-sm hover:bg-amber-50"}`}
                  >
                    Advarsler ({warnings})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter("pass")}
                    className={`rounded-full px-3 py-1.5 text-sm font-semibold transition ${filter === "pass" ? "bg-gradient-to-r from-emerald-500 to-green-600 text-white shadow-md" : "bg-white text-green-700 shadow-sm hover:bg-green-50"}`}
                  >
                    OK ({passed})
                  </button>
                </div>
                <input
                  type="search"
                  placeholder="Søg i fejl…"
                  value={issueSearchQuery}
                  onChange={(e) => setIssueSearchQuery(e.target.value)}
                  className="ml-auto w-48 rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  Sorter:
                  <select
                    value={issueSortBy}
                    onChange={(e) => setIssueSortBy(e.target.value as typeof issueSortBy)}
                    className="rounded border border-slate-300 px-2 py-1.5 text-sm"
                  >
                    <option value="severity">Alvorlighed</option>
                    <option value="category">Kategori</option>
                    <option value="title">Titel</option>
                    <option value="pages">Antal sider</option>
                  </select>
                </label>
              </div>

              {issueSearchQuery && (
                <p className="mt-2 text-sm text-slate-500">
                  {sortedIssues.length} af {filteredIssues.length} fejl matcher søgningen
                </p>
              )}

              <div className="mt-6 space-y-3">
                {filtered.map((issue: AuditIssue) => {
                  const affectedCount = issue.affectedPages?.length ?? (issue.pageUrl?.includes(" sider") ? parseInt(issue.pageUrl) : (issue.pageUrl ? 1 : 0));
                  return (
                    <div
                      key={issue.id}
                      className={`rounded-xl border-2 p-5 transition-all hover:shadow-lg hover:scale-[1.01] cursor-pointer ${severityStyles[issue.severity]}`}
                      onClick={() => setSelectedIssue(issue)}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded px-2 py-0.5 text-xs font-semibold uppercase">
                          {severityLabels[issue.severity]}
                        </span>
                        <span className="text-sm text-slate-600">{issue.category}</span>
                        {affectedCount > 0 && (
                          <span className="text-xs font-medium text-slate-700">
                            {affectedCount} side{affectedCount !== 1 ? "r" : ""}
                          </span>
                        )}
                      </div>
                      <h3 className="mt-2 font-semibold">{issue.title}</h3>
                      <p className="mt-1 text-sm opacity-90">{issue.message}</p>
                      {issue.affectedPages && issue.affectedPages.length > 0 && issue.affectedPages.length <= 5 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {issue.affectedPages.map((url) => (
                            <Link
                              key={url}
                              href={`/page/${encodeURIComponent(url)}`}
                              prefetch={false}
                              onClick={(e) => e.stopPropagation()}
                              className="text-xs font-medium text-sky-600 hover:text-sky-700 hover:underline transition"
                            >
                              {url}
                            </Link>
                          ))}
                        </div>
                      )}
                      {issue.affectedPages && issue.affectedPages.length > 5 && (
                        <p className="mt-2 text-xs text-slate-600">
                          Klik for at se alle {issue.affectedPages.length} berørte sider →
                        </p>
                      )}
                      {issue.value && (
                        <div className="mt-2 rounded bg-white/50 px-2 py-1.5 text-xs">
                          {issue.category === "Billeder" && issue.title.includes("alt-tekst") ? (
                            <ImageListComponent images={issue.value} />
                          ) : (
                            <p className="break-all">{issue.value}</p>
                          )}
                        </div>
                      )}
                      {issue.recommendation && (
                        <p className="mt-2 text-sm italic opacity-90">
                          → {issue.recommendation}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              {filtered.length === 0 && (
                <p className="mt-6 text-center text-slate-500">
                  Ingen fund med valgt filter{sortedIssues.length !== filteredIssues.length ? " og søgning" : ""}.
                </p>
              )}
            </>
          )}

          {/* Modal for at vise alle berørte sider for en fejl */}
          {selectedIssue && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
              onClick={() => setSelectedIssue(null)}
            >
              <div
                className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-8 shadow-2xl border-2 border-sky-100"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-6 flex items-center justify-between border-b-2 border-slate-100 pb-4">
                  <h2 className="text-2xl font-bold bg-gradient-to-r from-sky-600 to-blue-600 bg-clip-text text-transparent">{selectedIssue.title}</h2>
                  <button
                    type="button"
                    onClick={() => setSelectedIssue(null)}
                    className="rounded-lg p-2 text-slate-500 hover:bg-sky-50 hover:text-sky-600 transition"
                  >
                    ✕
                  </button>
                </div>
                <div className="mb-6 flex flex-wrap gap-2">
                  <span className={`rounded-lg px-3 py-1.5 text-xs font-semibold uppercase shadow-sm ${severityStyles[selectedIssue.severity]}`}>
                    {severityLabels[selectedIssue.severity]}
                  </span>
                  <span className="rounded-lg bg-gradient-to-r from-slate-100 to-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm">{selectedIssue.category}</span>
                  {selectedIssue.affectedPages && (
                    <span className="rounded-lg bg-gradient-to-r from-sky-100 to-blue-100 px-3 py-1.5 text-xs font-semibold text-sky-800 shadow-sm">
                      {selectedIssue.affectedPages.length} side{selectedIssue.affectedPages.length !== 1 ? "r" : ""} berørt
                    </span>
                  )}
                </div>
                <p className="mb-4 text-base text-slate-700 leading-relaxed">{selectedIssue.message}</p>
                {selectedIssue.recommendation && (
                  <div className="mb-6 rounded-lg bg-gradient-to-r from-sky-50 to-blue-50 border-2 border-sky-200 p-4">
                    <p className="text-sm font-semibold text-sky-900">💡 Anbefaling:</p>
                    <p className="mt-1 text-sm text-slate-700">{selectedIssue.recommendation}</p>
                  </div>
                )}
                {selectedIssue.value && (
                  <div className="mb-6 rounded-lg bg-gradient-to-br from-slate-50 to-slate-100 border-2 border-slate-200 p-4">
                    {selectedIssue.category === "Billeder" && selectedIssue.title.includes("alt-tekst") ? (
                      <div>
                        <span className="font-semibold text-slate-800">Billeder uden alt-tekst:</span>
                        <ImageListComponent images={selectedIssue.value} />
                      </div>
                    ) : (
                      <>
                        <span className="font-semibold text-slate-800">Værdi:</span>
                        <p className="mt-2 break-all text-sm text-slate-700">{selectedIssue.value}</p>
                      </>
                    )}
                  </div>
                )}
                {selectedIssue.affectedPages && selectedIssue.affectedPages.length > 0 && (
                  <div>
                    <h3 className="mb-3 text-lg font-bold text-slate-800">Berørte sider:</h3>
                    <div className="space-y-2">
                      {selectedIssue.affectedPages.map((pageUrl) => (
                        <Link
                          key={pageUrl}
                          href={`/page/${encodeURIComponent(pageUrl)}`}
                          prefetch={false}
                          className="block rounded-lg border-2 border-sky-200 bg-white p-3 text-sm font-medium text-sky-600 transition hover:border-sky-400 hover:bg-gradient-to-r hover:from-sky-50 hover:to-blue-50 hover:shadow-md"
                        >
                          {pageUrl}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === "pages" && full && (
            <div className="mt-6 space-y-3">
              <h2 className="text-lg font-semibold text-slate-800">Score pr. side</h2>
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <input
                  type="search"
                  placeholder="Søg på URL eller produkt…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-64 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  Sorter:
                  <select
                    value={sortPagesBy}
                    onChange={(e) => setSortPagesBy(e.target.value as typeof sortPagesBy)}
                    className="rounded border border-slate-300 px-2 py-1.5 text-sm"
                  >
                    <option value="score-asc">Score (lav først)</option>
                    <option value="score-desc">Score (høj først)</option>
                    <option value="url">URL A–Å</option>
                    <option value="category">Kategori</option>
                  </select>
                </label>
                {searchLower && (
                  <span className="text-sm text-slate-500">
                    {sortedPages.length} af {filteredPages.length} sider
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {paginatedPages.map((p, idx) => (
                  <Link
                    key={p?.url ?? `page-${idx}`}
                    href={`/page/${encodeURIComponent(p?.url ?? "")}`}
                    prefetch={false}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-4 transition hover:border-slate-400 hover:shadow-sm"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-medium text-slate-400">{pageCategory(p?.url ?? "")}</span>
                      <span className="ml-2 truncate text-sm text-slate-700">{p?.url ?? ""}</span>
                    </div>
                    <span className="font-semibold text-slate-800">{typeof p?.score === "number" ? p.score : 0}%</span>
                  </Link>
                ))}
              </div>
              {sortedPages.length === 0 && (
                <p className="text-sm text-slate-500">Ingen sider matcher søgningen.</p>
              )}
              {totalPages > 1 && (
                <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm text-slate-600">
                    Side {pageNum} af {totalPages} ({sortedPages.length} sider totalt)
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => setPageNum((p) => Math.max(1, p - 1))}
                      disabled={pageNum === 1}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      ← Forrige
                    </button>
                    {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                      let pageToShow: number;
                      if (totalPages <= 5) {
                        pageToShow = i + 1;
                      } else if (pageNum <= 3) {
                        pageToShow = i + 1;
                      } else if (pageNum >= totalPages - 2) {
                        pageToShow = totalPages - 4 + i;
                      } else {
                        pageToShow = pageNum - 2 + i;
                      }
                      return (
                        <button
                          key={pageToShow}
                          type="button"
                          onClick={() => setPageNum(pageToShow)}
                          className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${pageNum === pageToShow
                              ? "border-slate-800 bg-slate-800 text-white"
                              : "border-slate-300 text-slate-700 hover:bg-slate-50"
                            }`}
                        >
                          {pageToShow}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setPageNum((p) => Math.min(totalPages, p + 1))}
                      disabled={pageNum === totalPages}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Næste →
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "eeat" && full && (
            <div className="mt-6 space-y-6">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">E-E-A-T Analysis</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Experience, Expertise, Authoritativeness, and Trust signals across your website
                </p>
              </div>

              {full.eeat ? (
                <>
                  {/* Top Row Metrics */}
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 p-6 text-white shadow-lg">
                      <div className="text-3xl font-bold">{full.eeat.score ?? 0}</div>
                      <div className="mt-1 text-sm font-medium text-green-100">OVERALL E-E-A-T SCORE</div>
                      <div className="mt-1 text-xs text-green-200">Out of 100</div>
                    </div>
                    <div className="rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 p-6 text-white shadow-lg">
                      <div className="text-3xl font-bold">{full.eeat.pagesWithAuthor ?? 0}</div>
                      <div className="mt-1 text-sm font-medium text-green-100">PAGES WITH AUTHOR INFO</div>
                      <div className="mt-1 text-xs text-green-200">
                        {full.pagesAudited > 0 ? Math.round(((full.eeat.pagesWithAuthor ?? 0) / full.pagesAudited) * 100) : 0}% of pages
                      </div>
                    </div>
                    <div className="rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 p-6 text-white shadow-lg">
                      <div className="text-3xl font-bold">{full.eeat.pagesWithSchema ?? 0}</div>
                      <div className="mt-1 text-sm font-medium text-blue-100">PAGES WITH SCHEMA MARKUP</div>
                      <div className="mt-1 text-xs text-blue-200">
                        {full.pagesAudited > 0 ? Math.round(((full.eeat.pagesWithSchema ?? 0) / full.pagesAudited) * 100) : 0}% of pages
                      </div>
                    </div>
                    <div className="rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 p-6 text-white shadow-lg">
                      <div className="text-3xl font-bold">{full.eeat.externalCitations ?? 0}</div>
                      <div className="mt-1 text-sm font-medium text-orange-100">EXTERNAL CITATIONS</div>
                      <div className="mt-1 text-xs text-orange-200">
                        Average {full.pagesAudited > 0 ? ((full.eeat.externalCitations ?? 0) / full.pagesAudited).toFixed(1) : "0.0"} per page
                      </div>
                    </div>
                  </div>

                  {/* Trust Signals Breakdown */}
                  <div>
                    <h3 className="mb-4 text-lg font-semibold text-slate-800">Trust Signals Breakdown</h3>
                    <div className="space-y-4">
                      <div className="rounded-lg border-2 border-slate-200 bg-white p-4 shadow-sm">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-semibold text-slate-800">Author Attribution</span>
                          <span className="font-bold text-slate-700">
                            {full.eeat.pagesWithAuthor ?? 0}/{full.pagesAudited}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-600"
                            style={{ width: `${full.pagesAudited > 0 ? Math.round(((full.eeat.pagesWithAuthor ?? 0) / full.pagesAudited) * 100) : 0}%` }}
                          />
                        </div>
                      </div>

                      <div className="rounded-lg border-2 border-slate-200 bg-white p-4 shadow-sm">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-semibold text-slate-800">Structured Data</span>
                          <span className="font-bold text-slate-700">
                            {full.eeat.pagesWithSchema ?? 0}/{full.pagesAudited}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-600"
                            style={{ width: `${full.pagesAudited > 0 ? Math.round(((full.eeat.pagesWithSchema ?? 0) / full.pagesAudited) * 100) : 0}%` }}
                          />
                        </div>
                      </div>

                      <div className="rounded-lg border-2 border-slate-200 bg-white p-4 shadow-sm">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-semibold text-slate-800">External Links</span>
                          <span className="font-bold text-slate-700">
                            {(() => {
                              const pagesWithExternal = full.pages.filter(p => {
                                const externalLinkIssues = p.issues.filter(i =>
                                  i.category === "Links & canonical" &&
                                  (i.title === "Eksterne links" || i.title === "Eksterne links mangler rel-attributter")
                                );
                                return externalLinkIssues.length > 0;
                              }).length;
                              return `${pagesWithExternal}/${full.pagesAudited}`;
                            })()}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-600"
                            style={{
                              width: `${(() => {
                                const pagesWithExternal = full.pages.filter(p => {
                                  const externalLinkIssues = p.issues.filter(i =>
                                    i.category === "Links & canonical" &&
                                    (i.title === "Eksterne links" || i.title === "Eksterne links mangler rel-attributter")
                                  );
                                  return externalLinkIssues.length > 0;
                                }).length;
                                return full.pagesAudited > 0 ? Math.round((pagesWithExternal / full.pagesAudited) * 100) : 0;
                              })()}%`
                            }}
                          />
                        </div>
                      </div>

                      <div className="rounded-lg border-2 border-slate-200 bg-white p-4 shadow-sm">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-semibold text-slate-800">Open Graph Tags</span>
                          <span className="font-bold text-slate-700">
                            {full.eeat.pagesWithOpenGraph ?? 0}/{full.pagesAudited}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-600"
                            style={{ width: `${full.pagesAudited > 0 ? Math.round(((full.eeat.pagesWithOpenGraph ?? 0) / full.pagesAudited) * 100) : 0}%` }}
                          />
                        </div>
                      </div>

                      <div className="rounded-lg border-2 border-slate-200 bg-white p-4 shadow-sm">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-semibold text-slate-800">HTTPS Secure</span>
                          <span className="font-bold text-slate-700">
                            {full.eeat.pagesWithHttps ?? 0}/{full.pagesAudited}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-600"
                            style={{ width: `${full.pagesAudited > 0 ? Math.round(((full.eeat.pagesWithHttps ?? 0) / full.pagesAudited) * 100) : 0}%` }}
                          />
                        </div>
                      </div>

                      <div className="rounded-lg border-2 border-slate-200 bg-white p-4 shadow-sm">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-semibold text-slate-800">Sufficient Content</span>
                          <span className="font-bold text-slate-700">
                            {full.eeat.pagesWithSufficientContent ?? 0}/{full.pagesAudited}
                          </span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                          <div
                            className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-green-600"
                            style={{ width: `${full.pagesAudited > 0 ? Math.round(((full.eeat.pagesWithSufficientContent ?? 0) / full.pagesAudited) * 100) : 0}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-lg border-2 border-amber-200 bg-amber-50 p-6">
                  <p className="text-amber-800">
                    Ingen EEAT-data tilgængelig. Kør en fuld site-audit for at få en EEAT-vurdering.
                  </p>
                </div>
              )}
            </div>
          )}

          {tab === "links" && full && (
            <div className="mt-6 space-y-6">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">Links</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Analyse af interne og eksterne links på tværs af sitet
                </p>
              </div>

              {/* Top Backlinks */}
              <div className="rounded-lg border-2 border-slate-200 bg-white p-6 shadow-sm">
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-lg font-semibold text-slate-800">Top backlinks</h3>
                    <p className="mt-2 text-sm text-slate-600">
                      Vi har ikke fundet nogen backlinks, der kan rapporteres til dette websted.
                    </p>
                  </div>
                  <button className="text-slate-400 hover:text-slate-600">
                    <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* On-Page Link Structure */}
              {full.linkStats && (
                <>
                  <div className="rounded-lg border-2 border-slate-200 bg-white p-6 shadow-sm">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-800">On-Page Link Struktur</h3>
                        <p className="mt-2 text-sm text-slate-600">
                          Vi fandt {full.linkStats.totalLinks} samlede links.{" "}
                          {full.linkStats.totalLinks > 0 && (
                            <>
                              {Math.round((full.linkStats.externalLinks / full.linkStats.totalLinks) * 100)}% af dine links er eksterne links og sender autoritet til andre websteder.{" "}
                              {Math.round((full.linkStats.noFollowLinks / full.linkStats.totalLinks) * 100)}% af dine links er nofollow-links, hvilket betyder, at autoritet ikke sendes til disse destinationssider.
                            </>
                          )}
                        </p>
                      </div>
                      <button className="text-slate-400 hover:text-slate-600">
                        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-8-3a1 1 0 00-.867.5 1 1 0 11-1.731-1A3 3 0 0113 8a3.001 3.001 0 01-2 2.83V11a1 1 0 11-2 0v-1a1 1 0 011-1 1 1 0 100-2zm0 8a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Links on the Page - Donut Chart */}
                  <div className="rounded-lg border-2 border-slate-200 bg-white p-6 shadow-sm">
                    <h3 className="mb-4 text-lg font-semibold text-slate-800">Links på siden</h3>
                    <div className="flex flex-col items-center gap-6 md:flex-row md:items-start">
                      {/* Donut Chart */}
                      <div className="relative flex h-48 w-48 items-center justify-center">
                        <svg className="h-full w-full -rotate-90 transform" viewBox="0 0 100 100">
                          <circle
                            cx="50"
                            cy="50"
                            r="40"
                            fill="none"
                            stroke="#e2e8f0"
                            strokeWidth="8"
                          />
                          {(() => {
                            const total = full.linkStats.totalLinks;
                            const internal = full.linkStats.internalLinks;
                            const externalFollow = full.linkStats.externalLinksFollow;
                            const externalNoFollow = full.linkStats.externalLinksNoFollow;

                            if (total === 0) return null;

                            const internalPercent = (internal / total) * 100;
                            const externalFollowPercent = (externalFollow / total) * 100;
                            const externalNoFollowPercent = (externalNoFollow / total) * 100;

                            let currentOffset = 0;

                            return (
                              <>
                                {/* Internal Links */}
                                <circle
                                  cx="50"
                                  cy="50"
                                  r="40"
                                  fill="none"
                                  stroke="#3b82f6"
                                  strokeWidth="8"
                                  strokeDasharray={`${2 * Math.PI * 40 * (internalPercent / 100)} ${2 * Math.PI * 40}`}
                                  strokeDashoffset={-2 * Math.PI * 40 * (currentOffset / 100)}
                                />
                                {currentOffset += internalPercent}

                                {/* External Follow */}
                                {externalFollowPercent > 0 && (
                                  <>
                                    <circle
                                      cx="50"
                                      cy="50"
                                      r="40"
                                      fill="none"
                                      stroke="#10b981"
                                      strokeWidth="8"
                                      strokeDasharray={`${2 * Math.PI * 40 * (externalFollowPercent / 100)} ${2 * Math.PI * 40}`}
                                      strokeDashoffset={-2 * Math.PI * 40 * (currentOffset / 100)}
                                    />
                                    {currentOffset += externalFollowPercent}
                                  </>
                                )}

                                {/* External NoFollow */}
                                {externalNoFollowPercent > 0 && (
                                  <circle
                                    cx="50"
                                    cy="50"
                                    r="40"
                                    fill="none"
                                    stroke="#ef4444"
                                    strokeWidth="8"
                                    strokeDasharray={`${2 * Math.PI * 40 * (externalNoFollowPercent / 100)} ${2 * Math.PI * 40}`}
                                    strokeDashoffset={-2 * Math.PI * 40 * (currentOffset / 100)}
                                  />
                                )}
                              </>
                            );
                          })()}
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <div className="text-center">
                            <div className="text-3xl font-bold text-slate-800">{full.linkStats.totalLinks}</div>
                            <div className="text-xs font-medium text-slate-600">Total</div>
                          </div>
                        </div>
                      </div>

                      {/* Legend */}
                      <div className="flex-1 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="h-4 w-4 rounded bg-blue-500"></div>
                            <span className="text-sm font-medium text-slate-700">Internal Links</span>
                          </div>
                          <span className="text-sm font-bold text-slate-800">{full.linkStats.internalLinks}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="h-4 w-4 rounded bg-green-500"></div>
                            <span className="text-sm font-medium text-slate-700">External Links: Follow</span>
                          </div>
                          <span className="text-sm font-bold text-slate-800">{full.linkStats.externalLinksFollow}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="h-4 w-4 rounded bg-red-500"></div>
                            <span className="text-sm font-medium text-slate-700">External Links: Nofollow</span>
                          </div>
                          <span className="text-sm font-bold text-slate-800">{full.linkStats.externalLinksNoFollow}</span>
                        </div>
                      </div>
                    </div>
                    <button className="mt-4 w-full rounded-lg bg-gradient-to-r from-sky-600 to-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-md transition hover:from-sky-700 hover:to-blue-700">
                      Show Details
                    </button>
                  </div>

                  {/* Friendly Links */}
                  <div className="rounded-lg border-2 border-slate-200 bg-white p-6 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-lg font-semibold text-slate-800">Venlige links</h3>
                        <p className="mt-2 text-sm text-slate-600">
                          {full.linkStats.friendlyLinks
                            ? "Dine link-URL'er ser ud til at være venlige (let menneskelige eller søgemaskine læsbare)."
                            : "Nogle af dine link-URL'er kunne være mere venlige (undgå lange query parametre og komplekse strukturer)."}
                        </p>
                      </div>
                      {full.linkStats.friendlyLinks ? (
                        <svg className="h-6 w-6 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                      ) : (
                        <svg className="h-6 w-6 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {tab === "speed" && full && (
            <div className="mt-6 space-y-6">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">Site Speed</h2>
                <p className="mt-1 text-sm text-slate-600">
                  Performance analyse baseret på PageSpeed Insights metrikker
                </p>
              </div>

              {full.speedStats ? (
                <>
                  {/* Overall Score */}
                  <div className="flex items-center justify-center">
                    <div className="relative flex h-48 w-48 items-center justify-center">
                      <svg className="h-full w-full -rotate-90 transform" viewBox="0 0 100 100">
                        <circle
                          cx="50"
                          cy="50"
                          r="40"
                          fill="none"
                          stroke="#e2e8f0"
                          strokeWidth="8"
                        />
                        <circle
                          cx="50"
                          cy="50"
                          r="40"
                          fill="none"
                          stroke={full.speedStats.score && full.speedStats.score >= 90 ? "#10b981" : full.speedStats.score && full.speedStats.score >= 50 ? "#f59e0b" : "#ef4444"}
                          strokeWidth="8"
                          strokeDasharray={`${2 * Math.PI * 40 * ((full.speedStats.score || 0) / 100)} ${2 * Math.PI * 40}`}
                        />
                      </svg>
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="text-center">
                          <div className="text-4xl font-bold text-slate-800">{full.speedStats.score ?? 0}</div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Lab Data */}
                  <div className="rounded-lg border-2 border-slate-200 bg-white p-6 shadow-sm">
                    <h3 className="mb-4 text-lg font-semibold text-slate-800">LABORATORIEDATA</h3>
                    <div className="space-y-3">
                      {full.speedStats.firstContentfulPaint !== undefined && (
                        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                          <span className="text-sm font-medium text-slate-700">First Contentful Paint</span>
                          <span className={`text-sm font-bold ${full.speedStats.firstContentfulPaint < 1.8 ? "text-green-600" : full.speedStats.firstContentfulPaint < 3 ? "text-amber-600" : "text-red-600"}`}>
                            {full.speedStats.firstContentfulPaint.toFixed(1)} s
                          </span>
                        </div>
                      )}
                      {full.speedStats.speedIndex !== undefined && (
                        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                          <span className="text-sm font-medium text-slate-700">Speed Index</span>
                          <span className={`text-sm font-bold ${full.speedStats.speedIndex < 3.4 ? "text-green-600" : full.speedStats.speedIndex < 5.8 ? "text-amber-600" : "text-red-600"}`}>
                            {full.speedStats.speedIndex.toFixed(1)} s
                          </span>
                        </div>
                      )}
                      {full.speedStats.largestContentfulPaint !== undefined && (
                        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                          <span className="text-sm font-medium text-slate-700">Largest Contentful Paint</span>
                          <span className={`text-sm font-bold ${full.speedStats.largestContentfulPaint < 2.5 ? "text-green-600" : full.speedStats.largestContentfulPaint < 4 ? "text-amber-600" : "text-red-600"}`}>
                            {full.speedStats.largestContentfulPaint.toFixed(1)} s
                          </span>
                        </div>
                      )}
                      {full.speedStats.timeToInteractive !== undefined && (
                        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                          <span className="text-sm font-medium text-slate-700">Time to Interactive</span>
                          <span className={`text-sm font-bold ${full.speedStats.timeToInteractive < 3.8 ? "text-green-600" : full.speedStats.timeToInteractive < 7.3 ? "text-amber-600" : "text-red-600"}`}>
                            {full.speedStats.timeToInteractive.toFixed(1)} s
                          </span>
                        </div>
                      )}
                      {full.speedStats.totalBlockingTime !== undefined && (
                        <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                          <span className="text-sm font-medium text-slate-700">Total Blocking Time</span>
                          <span className={`text-sm font-bold ${full.speedStats.totalBlockingTime < 200 ? "text-green-600" : full.speedStats.totalBlockingTime < 600 ? "text-amber-600" : "text-red-600"}`}>
                            {full.speedStats.totalBlockingTime.toFixed(2)} s
                          </span>
                        </div>
                      )}
                      {full.speedStats.cumulativeLayoutShift !== undefined && (
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-slate-700">Cumulative Layout Shift</span>
                          <span className={`text-sm font-bold ${full.speedStats.cumulativeLayoutShift < 0.1 ? "text-green-600" : full.speedStats.cumulativeLayoutShift < 0.25 ? "text-amber-600" : "text-red-600"}`}>
                            {full.speedStats.cumulativeLayoutShift.toFixed(3)}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Opportunities */}
                  {full.speedStats.opportunities && full.speedStats.opportunities.length > 0 && (
                    <div className="rounded-lg border-2 border-slate-200 bg-white p-6 shadow-sm">
                      <h3 className="mb-4 text-lg font-semibold text-slate-800">MULIGHEDER</h3>
                      <div className="space-y-3">
                        {full.speedStats.opportunities.map((opp, idx) => (
                          <div key={idx} className="flex items-center justify-between border-b border-slate-100 pb-2">
                            <span className="text-sm font-medium text-slate-700">{opp.title}</span>
                            <span className="text-sm font-bold text-red-600">{opp.savings.toFixed(2)} s</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Additional Checks */}
                  <div className="rounded-lg border-2 border-slate-200 bg-white p-6 shadow-sm">
                    <h3 className="mb-4 text-lg font-semibold text-slate-800">Yderligere checks</h3>
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-700">Flash brugt?</span>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-600">
                            {full.speedStats.hasFlash
                              ? "Flash-indhold identificeret"
                              : "Intet Flash-indhold er blevet identificeret på din side."}
                          </span>
                          {!full.speedStats.hasFlash && (
                            <svg className="h-5 w-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-700">iFrames brugt?</span>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-600">
                            {full.speedStats.hasIframes
                              ? "iFrames identificeret"
                              : "Der er ikke registreret iFrames på din side."}
                          </span>
                          {!full.speedStats.hasIframes && (
                            <svg className="h-5 w-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-slate-700">Favicon</span>
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-slate-600">
                            {full.speedStats.hasFavicon
                              ? "Din side har specificeret en Favicon."
                              : "Ingen Favicon identificeret"}
                          </span>
                          {full.speedStats.hasFavicon && (
                            <svg className="h-5 w-5 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                            </svg>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-lg border-2 border-amber-200 bg-amber-50 p-6">
                  <p className="text-amber-800">
                    Ingen Site Speed data tilgængelig. Kør en fuld site-audit for at få en Site Speed vurdering.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <footer className="mt-12 border-t border-slate-200 pt-6 text-center text-sm text-slate-500">
        SEO Audit – tekniske checks på tværs af titel, meta, overskrifter, billeder, mobil, social, crawl og indhold. Ikke erstatning for Google Search Console.
      </footer>
    </div>
  );
}

export default function SEOAuditPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-5xl px-4 py-8">Indlæser…</div>}>
      <SEOAuditPageContent />
    </Suspense>
  );
}
