"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import type { AuditResult, AuditIssue, Severity, FullSiteResult, ImprovementSuggestion } from "@/lib/audit";
import { buildSuggestionsFromAggregated } from "@/lib/suggestions";
import { getPillarForCategory, SEO_PILLARS, type SEOPillar } from "@/lib/seoPillars";

const BATCH_SIZE = 100; // Maksimal batch-størrelse for hurtigst mulig audit
const CONCURRENT_BATCHES = 15; // Kør 15 batches parallelt for maksimal hastighed

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
  const byKey = new Map<string, AuditIssue & { pages: string[] }>();
  for (const i of allIssues) {
    const key = `${i.category}|${i.severity}|${i.title}`;
    const existing = byKey.get(key);
    if (existing) {
      if (i.pageUrl && !existing.pages.includes(i.pageUrl)) existing.pages.push(i.pageUrl);
    } else {
      byKey.set(key, { ...i, pages: i.pageUrl ? [i.pageUrl] : [] });
    }
  }
  const aggregated: AuditIssue[] = Array.from(byKey.values()).map(({ pages: p, ...rest }) => ({
    ...rest,
    pageUrl: p.length > 0 ? (p.length === 1 ? p[0] : `${p.length} sider`) : undefined,
    affectedPages: p.length > 0 ? p : undefined,
  }));
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

function SEOAuditPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [url, setUrl] = useState("surfmore.dk");
  const [fullSite, setFullSite] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | FullSiteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [tab, setTab] = useState<"overview" | "suggestions" | "issues" | "pages" | "eeat">("overview");
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

  // Load gemt resultat fra localStorage ved mount
  useEffect(() => {
    const saved = localStorage.getItem(`seo-audit-${url}`);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setResult(parsed);
      } catch {
        // Ignorer hvis parsing fejler
      }
    }
  }, [url]);

  // Auto-start sitemap crawl når siden loader hvis URL er sat og fullSite er aktivt
  useEffect(() => {
    if (url && fullSite && !result && !loading && !error) {
      const timer = setTimeout(() => {
        run();
      }, 300);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Kun ved første mount

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress("Henter sitemap…");
    const domain = (url || "surfmore.dk").trim();
    const origin = domain.startsWith("http") ? new URL(domain).origin : `https://${domain}`;
    try {
      if (fullSite) {
        const sitemapRes = await fetch(`/api/sitemap?url=${encodeURIComponent(domain)}`);
        const sitemapData = await sitemapRes.json().catch(() => ({}));
        if (!sitemapRes.ok) throw new Error(sitemapData?.error || "Kunne ikke hente sitemap");
        const rawUrls = sitemapData.urls ?? sitemapData.urlsToAudit ?? sitemapData.allUrls;
        const allUrls: string[] = Array.isArray(rawUrls) ? rawUrls : [];
        const totalInSitemap = typeof sitemapData.totalInSitemap === "number" ? sitemapData.totalInSitemap : allUrls.length;
        setProgress(`Sitemap: ${allUrls.length} URLs. Starter audit…`);
        if (allUrls.length === 0) {
          const fallback = await fetch("/api/audit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: domain, fullSite: true }),
          });
          const fallbackData = await fallback.json().catch(() => ({}));
          if (!fallback.ok) throw new Error(fallbackData?.error || "Audit fejlede");
          if (fallbackData?.error) throw new Error(fallbackData.error);
          setResult(fallbackData);
        } else {
          const batches: FullSiteResult[] = [];
          const totalBatches = Math.ceil(allUrls.length / BATCH_SIZE);
          const chunks: string[][] = [];
          for (let i = 0; i < allUrls.length; i += BATCH_SIZE) {
            chunks.push(allUrls.slice(i, i + BATCH_SIZE));
          }
          // Kør batches parallelt i grupper af CONCURRENT_BATCHES
          for (let i = 0; i < chunks.length; i += CONCURRENT_BATCHES) {
            const group = chunks.slice(i, i + CONCURRENT_BATCHES);
            const batchStart = i + 1;
            const batchEnd = Math.min(i + CONCURRENT_BATCHES, chunks.length);
            setProgress(`Auditerer batches ${batchStart}–${batchEnd} af ${totalBatches} (${allUrls.length} sider totalt)…`);
            const groupResults = await Promise.all(
              group.map(async (chunk, idx) => {
                const batchNum = i + idx + 1;
                const res = await fetch("/api/audit", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ urlBatch: chunk, origin }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data?.error || `Batch ${batchNum} fejlede`);
                if (data?.error) throw new Error(`Batch ${batchNum}: ${data.error}`);
                return data;
              })
            );
            batches.push(...groupResults);
          }
          setProgress("Samler resultater…");
          const merged = mergeBatchResults(batches, totalInSitemap, origin);
          setResult(merged);
          // Gem kun essentiell data i localStorage (ikke alle pages for at undgå quota)
          try {
            const essentialData = {
              origin: merged.origin,
              overallScore: merged.overallScore,
              categories: merged.categories,
              pagesAudited: merged.pagesAudited,
              totalUrlsInSitemap: merged.totalUrlsInSitemap,
              aggregated: merged.aggregated,
              improvementSuggestions: merged.improvementSuggestions,
            };
            localStorage.setItem(`seo-audit-${domain}`, JSON.stringify(essentialData));
          } catch (e) {
            // Hvis localStorage stadig fejler, prøv at rydde gamle entries
            try {
              const keys = Object.keys(localStorage);
              const oldKeys = keys.filter(k => k.startsWith('seo-audit-'));
              oldKeys.forEach(k => localStorage.removeItem(k));
              const essentialData = {
                origin: merged.origin,
                overallScore: merged.overallScore,
                categories: merged.categories,
                pagesAudited: merged.pagesAudited,
                totalUrlsInSitemap: merged.totalUrlsInSitemap,
                aggregated: merged.aggregated,
                improvementSuggestions: merged.improvementSuggestions,
              };
              localStorage.setItem(`seo-audit-${domain}`, JSON.stringify(essentialData));
            } catch {
              // Ignorer hvis det stadig fejler
            }
          }
        }
      } else {
        const res = await fetch("/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: domain, fullSite: false }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Audit fejlede");
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
      setError(message || "Noget gik galt");
      console.error("SEO Audit error:", e);
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
    "Link building": {},
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
          <button
            type="button"
            onClick={run}
            disabled={loading}
            className="rounded-lg bg-gradient-to-r from-sky-600 to-blue-600 px-6 py-2.5 font-semibold text-white shadow-md transition hover:from-sky-700 hover:to-blue-700 hover:shadow-lg disabled:opacity-50 disabled:hover:shadow-md"
          >
            {loading ? (progress || (fullSite ? "Henter sitemap…" : "Kører audit…")) : "🚀 Kør audit"}
          </button>
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
                          <div>
                            <span className="font-medium text-slate-700">Billeder uden alt:</span>
                            <ul className="mt-1 ml-4 list-disc space-y-0.5">
                              {issue.value.split(", ").slice(0, 10).map((img, idx) => (
                                <li key={idx} className="break-all">{img}</li>
                              ))}
                              {issue.value.split(", ").length > 10 && (
                                <li className="text-slate-500">... og {issue.value.split(", ").length - 10} flere</li>
                              )}
                            </ul>
                          </div>
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
                    <span className="font-semibold text-slate-800">Værdi:</span>
                    <p className="mt-2 break-all text-sm text-slate-700">{selectedIssue.value}</p>
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
                          className={`rounded-lg border px-3 py-1.5 text-sm font-medium ${
                            pageNum === pageToShow
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
                            style={{ width: `${(() => {
                              const pagesWithExternal = full.pages.filter(p => {
                                const externalLinkIssues = p.issues.filter(i => 
                                  i.category === "Links & canonical" && 
                                  (i.title === "Eksterne links" || i.title === "Eksterne links mangler rel-attributter")
                                );
                                return externalLinkIssues.length > 0;
                              }).length;
                              return full.pagesAudited > 0 ? Math.round((pagesWithExternal / full.pagesAudited) * 100) : 0;
                            })()}%` }}
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
