"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
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

export default function PageDetail() {
  const params = useParams();
  const router = useRouter();
  const encodedUrl = params.url as string;
  const url = decodeURIComponent(encodedUrl);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Severity | "all">("all");

  useEffect(() => {
    const run = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/audit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, fullSite: false }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error || "Audit fejlede");
        if (data?.error) throw new Error(data.error);
        setResult(data);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setError(message || "Noget gik galt");
      } finally {
        setLoading(false);
      }
    };
    if (url) run();
  }, [url]);

  const issues = result?.issues ?? [];
  const filtered =
    filter === "all"
      ? issues
      : issues.filter((i) => i.severity === filter);
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  const passed = issues.filter((i) => i.severity === "pass").length;
  const score = result?.score ?? 0;
  const categories = result?.categories ?? {};

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <button
        type="button"
        onClick={() => router.back()}
        className="mb-4 text-sm text-slate-600 hover:text-slate-800"
      >
        ← Tilbage
      </button>

      <h1 className="text-2xl font-bold text-slate-800 md:text-3xl">
        SEO Rapport: {url}
      </h1>

      {loading && (
        <p className="mt-4 text-slate-600">Henter rapport…</p>
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

          {Object.keys(categories).length > 0 && (
            <div className="mt-6">
              <h2 className="mb-3 text-lg font-semibold text-slate-800">Score pr. kategori</h2>
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

          <div className="mt-6 flex flex-wrap gap-2">
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
                  <p className="mt-2 rounded bg-white/50 px-2 py-1 text-xs break-all">
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

          {filtered.length === 0 && (
            <p className="mt-6 text-center text-slate-500">
              Ingen fund med valgt filter.
            </p>
          )}
        </>
      )}
    </div>
  );
}
