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
  return {
    origin,
    pages,
    aggregated,
    overallScore,
    categories,
    pagesAudited: pages.length,
    totalUrlsInSitemap,
    improvementSuggestions,
  };
}

const severityStyles: Record<Severity, string> = {
  error: "bg-red-100 text-red-800 border-red-200",
  warning: "bg-amber-100 text-amber-800 border-amber-200",
  pass: "bg-green-100 text-green-800 border-green-200",
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
          // Gem resultat i localStorage
          localStorage.setItem(`seo-audit-${domain}`, JSON.stringify(merged));
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
        // Gem også single-page resultat
        localStorage.setItem(`seo-audit-${domain}`, JSON.stringify(data));
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
    "Off-page SEO": {},
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
    <div className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-800 md:text-3xl">
        SEO Audit – hele sitet
      </h1>
      <p className="mt-1 text-slate-600">
        Tjek forsiden eller hele sitet via sitemap. Titel, meta, overskrifter, billeder, mobil, social, crawl m.m.
      </p>

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">URL / domæne</span>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="surfmore.dk"
            className="w-64 rounded-lg border border-slate-300 px-4 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={fullSite}
            onChange={(e) => setFullSite(e.target.checked)}
            className="rounded border-slate-300"
          />
          <span className="text-sm text-slate-700">Hele sitet (crawler sitemap, auditerer alle sider i batches)</span>
        </label>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="rounded-lg bg-slate-800 px-5 py-2.5 font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? (progress || (fullSite ? "Henter sitemap…" : "Kører audit…")) : "Kør audit"}
        </button>
      </div>

      {loading && progress && (
        <p className="mt-2 text-sm text-slate-600">{progress}</p>
      )}

      {error && (
        <div className="mt-4 rounded-lg bg-red-50 p-4 text-red-700">
          {error}
        </div>
      )}

      {result && (
        <>
          <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="text-2xl font-bold text-slate-800">{score}%</div>
              <div className="text-sm text-slate-500">Score</div>
            </div>
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="text-2xl font-bold text-green-600">{passed}</div>
              <div className="text-sm text-slate-500">OK</div>
            </div>
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="text-2xl font-bold text-amber-600">{warnings}</div>
              <div className="text-sm text-slate-500">Advarsler</div>
            </div>
            <div className="rounded-xl bg-white p-4 shadow-sm">
              <div className="text-2xl font-bold text-red-600">{errors}</div>
              <div className="text-sm text-slate-500">Fejl</div>
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
                    className={`rounded-full px-3 py-1.5 text-sm font-medium ${pillarFilter === "all" ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600"}`}
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
                      className={`rounded-full px-3 py-1.5 text-sm font-medium ${pillarFilter === p ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-600"}`}
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

          {tab === "suggestions" && full && suggestionsToShow.length > 0 && (
            <div className="mt-6 space-y-4">
              <h2 className="text-lg font-semibold text-slate-800">Forbedringsforslag</h2>
              <p className="text-sm text-slate-600">
                Konkrete skridt for at rette fejl og advarsler. {pillarFilter !== "all" && `Filtreret: ${pillarFilter}.`} Sorteret efter alvorlighed (fejl først).
              </p>
              <div className="space-y-4">
                {suggestionsToShow.map((s: ImprovementSuggestion) => (
                  <div
                    key={s.id}
                    className={`rounded-xl border p-4 ${s.severity === "error" ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${s.severity === "error" ? "bg-red-200 text-red-800" : "bg-amber-200 text-amber-800"}`}>
                        {s.severity === "error" ? "Fejl" : "Advarsel"}
                      </span>
                      <span className="text-sm text-slate-600">{s.category}</span>
                      <span className="text-xs text-slate-500">· {s.affectedCount} side{s.affectedCount !== 1 ? "r" : ""} berørt</span>
                    </div>
                    <h3 className="mt-2 font-semibold text-slate-800">{s.title}</h3>
                    <p className="mt-1 text-sm text-slate-700">{s.recommendation}</p>
                    {s.fixExample && (
                      <div className="mt-3 rounded-lg bg-white p-3 font-mono text-xs text-slate-800">
                        <span className="text-slate-500">Eksempel på rettelse:</span>
                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all">{s.fixExample}</pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {tab === "overview" && full && Object.keys(categories).length > 0 && (
            <div className="mt-6 space-y-6">
              <h2 className="text-lg font-semibold text-slate-800">
                Score pr. SEO-pille og kategori
                {pillarFilter !== "all" && ` (${pillarFilter})`}
              </h2>
              {(pillarFilter === "all" ? SEO_PILLARS : [pillarFilter as SEOPillar]).map((pillar) => {
                const cats = pillarCategories[pillar];
                const entries = Object.entries(cats);
                if (entries.length === 0) return null;
                return (
                  <div key={pillar}>
                    <h3 className="mb-2 font-medium text-slate-700">{pillar}</h3>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {entries.map(([name, c]) => {
                        const total = c.passed + c.failed + c.warnings;
                        const pct = total > 0 ? Math.round((c.passed / total) * 100) : 0;
                        return (
                          <div key={name} className="rounded-lg border border-slate-200 bg-white p-4">
                            <div className="flex justify-between">
                              <span className="font-medium text-slate-700">{name}</span>
                              <span className="text-slate-500">{pct}%</span>
                            </div>
                            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-100">
                              <div
                                className="h-full rounded-full bg-green-500"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <p className="mt-1 text-xs text-slate-500">
                              {c.totalPages} side{c.totalPages !== 1 ? "r" : ""} · {c.passed} OK, {c.warnings} advarsler, {c.failed} fejl
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {(tab === "issues" || !full) && (
            <>
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setFilter("all")}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === "all" ? "bg-slate-800 text-white" : "bg-slate-200 text-slate-700"}`}
                  >
                    Alle ({issues.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter("error")}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === "error" ? "bg-red-600 text-white" : "bg-red-100 text-red-800"}`}
                  >
                    Fejl ({errors})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter("warning")}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === "warning" ? "bg-amber-600 text-white" : "bg-amber-100 text-amber-800"}`}
                  >
                    Advarsler ({warnings})
                  </button>
                  <button
                    type="button"
                    onClick={() => setFilter("pass")}
                    className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === "pass" ? "bg-green-600 text-white" : "bg-green-100 text-green-800"}`}
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
                      className={`rounded-lg border p-4 transition hover:shadow-md cursor-pointer ${severityStyles[issue.severity]}`}
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
                              className="text-xs text-blue-600 hover:underline"
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
                className="max-h-[80vh] w-full max-w-3xl overflow-y-auto rounded-lg bg-white p-6 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="text-xl font-bold text-slate-800">{selectedIssue.title}</h2>
                  <button
                    type="button"
                    onClick={() => setSelectedIssue(null)}
                    className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
                  >
                    ✕
                  </button>
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  <span className={`rounded px-2 py-1 text-xs font-semibold uppercase ${severityStyles[selectedIssue.severity]}`}>
                    {severityLabels[selectedIssue.severity]}
                  </span>
                  <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{selectedIssue.category}</span>
                  {selectedIssue.affectedPages && (
                    <span className="rounded bg-blue-100 px-2 py-1 text-xs font-medium text-blue-800">
                      {selectedIssue.affectedPages.length} side{selectedIssue.affectedPages.length !== 1 ? "r" : ""} berørt
                    </span>
                  )}
                </div>
                <p className="mb-4 text-sm text-slate-700">{selectedIssue.message}</p>
                {selectedIssue.recommendation && (
                  <p className="mb-4 text-sm italic text-slate-600">→ {selectedIssue.recommendation}</p>
                )}
                {selectedIssue.value && (
                  <div className="mb-4 rounded bg-slate-50 p-3 text-xs">
                    <span className="font-medium text-slate-700">Værdi:</span>
                    <p className="mt-1 break-all">{selectedIssue.value}</p>
                  </div>
                )}
                {selectedIssue.affectedPages && selectedIssue.affectedPages.length > 0 && (
                  <div>
                    <h3 className="mb-2 font-semibold text-slate-800">Berørte sider:</h3>
                    <div className="space-y-1">
                      {selectedIssue.affectedPages.map((pageUrl) => (
                        <Link
                          key={pageUrl}
                          href={`/page/${encodeURIComponent(pageUrl)}`}
                          className="block rounded border border-slate-200 bg-white p-2 text-sm text-blue-600 hover:bg-slate-50 hover:underline"
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
            <div className="mt-6 space-y-4">
              <h2 className="text-lg font-semibold text-slate-800">EEAT Oversigt (Experience, Expertise, Authoritativeness, Trustworthiness)</h2>
              <p className="text-sm text-slate-600">
                EEAT er Googles retningslinjer for kvalitetsindhold. Her er en oversigt over hvor godt sitet opfylder EEAT-kriterierne.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                {full.pages.map((page) => {
                  const eeat = page.eeat;
                  if (!eeat) return null;
                  const score = [
                    eeat.author ? 1 : 0,
                    eeat.authorBio ? 1 : 0,
                    eeat.expertise ? 1 : 0,
                    eeat.trustworthiness ? 1 : 0,
                    eeat.aboutPage ? 1 : 0,
                    eeat.contactInfo ? 1 : 0,
                  ].reduce((a, b) => a + b, 0);
                  const maxScore = 6;
                  const pct = Math.round((score / maxScore) * 100);
                  return (
                    <div key={page.url} className="rounded-lg border border-slate-200 bg-white p-4">
                      <div className="mb-2 flex items-center justify-between">
                        <span className="truncate text-sm font-medium text-slate-700">{page.url}</span>
                        <span className="text-sm font-semibold text-slate-800">{pct}%</span>
                      </div>
                      <div className="space-y-1.5 text-xs">
                        <div className="flex items-center gap-2">
                          <span className={eeat.author ? "text-green-600" : "text-red-600"}>
                            {eeat.author ? "✓" : "✗"}
                          </span>
                          <span className="text-slate-600">Forfatter: {eeat.author || "Mangler"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={eeat.authorBio ? "text-green-600" : "text-red-600"}>
                            {eeat.authorBio ? "✓" : "✗"}
                          </span>
                          <span className="text-slate-600">Forfatterbiografi</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={eeat.expertise ? "text-green-600" : "text-red-600"}>
                            {eeat.expertise ? "✓" : "✗"}
                          </span>
                          <span className="text-slate-600">Ekspertise-signaler</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={eeat.trustworthiness ? "text-green-600" : "text-red-600"}>
                            {eeat.trustworthiness ? "✓" : "✗"}
                          </span>
                          <span className="text-slate-600">Troværdighed</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={eeat.aboutPage ? "text-green-600" : "text-red-600"}>
                            {eeat.aboutPage ? "✓" : "✗"}
                          </span>
                          <span className="text-slate-600">Om-side link</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={eeat.contactInfo ? "text-green-600" : "text-red-600"}>
                            {eeat.contactInfo ? "✓" : "✗"}
                          </span>
                          <span className="text-slate-600">Kontaktinformation</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {full.pages.filter((p) => !p.eeat).length > 0 && (
                <p className="text-sm text-slate-500">
                  {full.pages.filter((p) => !p.eeat).length} sider har ikke EEAT-data (måske ikke-2xx sider der blev sprunget over).
                </p>
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
