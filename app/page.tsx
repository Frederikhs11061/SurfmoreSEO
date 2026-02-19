"use client";

import { useState } from "react";
import type { AuditResult, AuditIssue, Severity } from "@/lib/audit";

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

export default function SEOAuditPage() {
  const [url, setUrl] = useState("surfmore.dk");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Severity | "all">("all");

  const run = async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url || "surfmore.dk" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Audit fejlede");
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Noget gik galt");
    } finally {
      setLoading(false);
    }
  };

  const issues = result?.issues ?? [];
  const filtered =
    filter === "all"
      ? issues
      : issues.filter((i) => i.severity === filter);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const passed = issues.filter((i) => i.severity === "pass").length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold text-slate-800 md:text-3xl">
        SEO Audit
      </h1>
      <p className="mt-1 text-slate-600">
        Find fejl og advarsler på tværs af titel, meta, overskrifter, billeder, links og mere.
      </p>

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium text-slate-700">URL / domæne</span>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="surfmore.dk"
            className="rounded-lg border border-slate-300 px-4 py-2 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
        <button
          type="button"
          onClick={run}
          disabled={loading}
          className="rounded-lg bg-slate-800 px-5 py-2.5 font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {loading ? "Kører audit…" : "Kør audit"}
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
              <div className="text-2xl font-bold text-slate-800">{result.score}%</div>
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

          <p className="mt-8 text-sm text-slate-500">
            Auditeret: {result.url}
          </p>
        </>
      )}

      <footer className="mt-12 border-t border-slate-200 pt-6 text-center text-sm text-slate-500">
        SEO Audit for SURFMORE – tekniske checks. Ikke erstatning for Google Search Console eller et fuldt værktøj som SEO Site Checkup.
      </footer>
    </div>
  );
}
