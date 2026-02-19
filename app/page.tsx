"use client";

import { useState } from "react";
import type { AuditResult, AuditIssue, Severity, FullSiteResult } from "@/lib/audit";

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

export default function SEOAuditPage() {
  const [url, setUrl] = useState("surfmore.dk");
  const [fullSite, setFullSite] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | FullSiteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Severity | "all">("all");
  const [tab, setTab] = useState<"overview" | "issues" | "pages">("overview");

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url || "surfmore.dk", fullSite }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Audit fejlede");
      setResult(data);
      setTab("overview");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Noget gik galt");
    } finally {
      setLoading(false);
    }
  };

  const full = result && isFullSiteResult(result) ? result : null;
  const single = result && !isFullSiteResult(result) ? result : null;

  const issues = full ? full.aggregated : single ? single.issues : [];
  const filtered =
    filter === "all"
      ? issues
      : issues.filter((i) => i.severity === filter);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const passed = issues.filter((i) => i.severity === "pass").length;
  const score = full ? full.overallScore : single ? single.score : 0;
  const categories = full ? full.categories : single ? single.categories : {};

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
          <span className="text-sm text-slate-700">Hele sitet (via sitemap, op til 8 sider)</span>
        </label>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="rounded-lg bg-slate-800 px-5 py-2.5 font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? (fullSite ? "Crawler sitemap og tjekker sider…" : "Kører audit…") : "Kør audit"}
        </button>
      </div>

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
              Auditeret: {full.origin} – {full.pagesAudited} sider
            </p>
          )}
          {single && (
            <p className="mt-2 text-sm text-slate-500">
              Auditeret: {single.url}
            </p>
          )}

          {full && (
            <div className="mt-6 flex gap-2 border-b border-slate-200">
              <button
                type="button"
                onClick={() => setTab("overview")}
                className={`border-b-2 px-3 py-2 text-sm font-medium ${tab === "overview" ? "border-slate-800 text-slate-800" : "border-transparent text-slate-500"}`}
              >
                Overblik
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
            </div>
          )}

          {tab === "overview" && full && Object.keys(categories).length > 0 && (
            <div className="mt-6 space-y-4">
              <h2 className="text-lg font-semibold text-slate-800">Score pr. kategori</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries(categories).map(([name, c]) => {
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
                        {c.passed} OK, {c.warnings} advarsler, {c.failed} fejl
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {(tab === "issues" || !full) && (
            <>
              <div className="mt-6 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setFilter("all")}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === "all" ? "bg-slate-800 text-white" : "bg-slate-200 text-slate-700"}`}
                >
                  Alle
                </button>
                <button
                  type="button"
                  onClick={() => setFilter("error")}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === "error" ? "bg-red-600 text-white" : "bg-red-100 text-red-800"}`}
                >
                  Fejl
                </button>
                <button
                  type="button"
                  onClick={() => setFilter("warning")}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === "warning" ? "bg-amber-600 text-white" : "bg-amber-100 text-amber-800"}`}
                >
                  Advarsler
                </button>
                <button
                  type="button"
                  onClick={() => setFilter("pass")}
                  className={`rounded-full px-3 py-1.5 text-sm font-medium ${filter === "pass" ? "bg-green-600 text-white" : "bg-green-100 text-green-800"}`}
                >
                  OK
                </button>
              </div>

              <div className="mt-6 space-y-3">
                {filtered.map((issue: AuditIssue) => (
                  <div
                    key={issue.id}
                    className={`rounded-lg border p-4 ${severityStyles[issue.severity]}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded px-2 py-0.5 text-xs font-semibold uppercase">
                        {severityLabels[issue.severity]}
                      </span>
                      <span className="text-sm text-slate-600">{issue.category}</span>
                      {issue.pageUrl && (
                        <span className="text-xs text-slate-500">
                          {issue.pageUrl}
                        </span>
                      )}
                    </div>
                    <h3 className="mt-2 font-semibold">{issue.title}</h3>
                    <p className="mt-1 text-sm opacity-90">{issue.message}</p>
                    {issue.value && (
                      <p className="mt-2 truncate rounded bg-white/50 px-2 py-1 text-xs">
                        {issue.value}
                      </p>
                    )}
                    {issue.recommendation && (
                      <p className="mt-2 text-sm italic opacity-90">
                        → {issue.recommendation}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === "pages" && full && (
            <div className="mt-6 space-y-3">
              <h2 className="text-lg font-semibold text-slate-800">Score pr. side</h2>
              {full.pages.map((p) => (
                <div
                  key={p.url}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-4"
                >
                  <span className="truncate text-sm text-slate-700">{p.url}</span>
                  <span className="font-semibold text-slate-800">{p.score}%</span>
                </div>
              ))}
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
