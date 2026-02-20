"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import type { AuditResult, AuditIssue, Severity } from "@/lib/audit";

function ImageListComponent({ images }: { images: string }) {
  const [showAll, setShowAll] = useState(false);
  
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
  const displayCount = showAll ? uniqueUrls.length : Math.min(5, uniqueUrls.length);
  
  return (
    <div className="mt-1">
      <div className="mb-1 flex items-center justify-between">
        <span className="font-medium text-slate-700">
          {uniqueUrls.length} unikke billeder uden alt-tekst
        </span>
        {uniqueUrls.length > 5 && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-xs text-blue-600 hover:text-blue-800 hover:underline font-medium"
          >
            {showAll ? "Vis færre" : `Vis alle (${uniqueUrls.length})`}
          </button>
        )}
      </div>
      <div className="max-h-48 overflow-y-auto">
        <ul className="space-y-1">
          {uniqueUrls.slice(0, displayCount).map((img, idx) => {
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
                    className="text-blue-600 hover:text-blue-800 hover:underline truncate max-w-[400px]"
                    title={img}
                  >
                    {filename}
                  </a>
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
                    className="text-blue-600 hover:text-blue-800 hover:underline truncate max-w-[400px]"
                  >
                    {img.length > 50 ? `${img.substring(0, 50)}...` : img}
                  </a>
                </li>
              );
            }
          })}
        </ul>
      </div>
    </div>
  );
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
    <div className="mx-auto max-w-6xl px-4 py-8">
      <button
        type="button"
        onClick={() => router.back()}
        className="mb-6 rounded-lg bg-gradient-to-r from-sky-600 to-blue-600 px-4 py-2 font-semibold text-white shadow-md transition hover:from-sky-700 hover:to-blue-700 hover:shadow-lg"
      >
        ← Tilbage
      </button>

      <div className="mb-8 rounded-2xl bg-gradient-to-r from-sky-600 via-blue-600 to-cyan-600 p-8 text-white shadow-xl">
        <h1 className="text-3xl font-bold md:text-4xl">SEO Rapport</h1>
        <p className="mt-2 text-blue-100 break-all">{url}</p>
      </div>

      {loading && (
        <div className="mb-4 rounded-lg bg-blue-50 border-2 border-blue-200 p-4">
          <p className="text-sm font-medium text-blue-800">Indlæser audit...</p>
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
          <div className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
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

          {Object.keys(categories).length > 0 && (
            <div className="mb-6">
              <h2 className="mb-3 text-lg font-semibold text-slate-800">Score pr. kategori</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {Object.entries(categories).map(([name, c]) => {
                  const total = c.passed + c.failed + c.warnings;
                  const pct = total > 0 ? Math.round((c.passed / total) * 100) : 0;
                  return (
                    <div key={name} className="rounded-lg border-2 border-slate-200 bg-white p-4 shadow-sm">
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
                        {c.passed} OK, {c.warnings} advarsler, {c.failed} fejl
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mb-6 flex flex-wrap gap-2">
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

          <div className="space-y-3">
            {filtered.map((issue: AuditIssue) => (
              <div
                key={issue.id}
                className={`rounded-xl border-2 p-5 transition-all hover:shadow-lg ${severityStyles[issue.severity]}`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-lg px-2 py-0.5 text-xs font-semibold uppercase">
                    {severityLabels[issue.severity]}
                  </span>
                  <span className="text-sm font-medium text-slate-600">{issue.category}</span>
                </div>
                <h3 className="mt-2 text-lg font-bold">{issue.title}</h3>
                <p className="mt-1 text-sm opacity-90">{issue.message}</p>
                {issue.value && (
                  <div className="mt-3 rounded-lg bg-white/50 px-3 py-2 text-xs">
                    {issue.category === "Billeder" && issue.title.includes("alt-tekst") ? (
                      <div>
                        <span className="font-medium text-slate-700">Billeder uden alt-tekst:</span>
                        <ImageListComponent images={issue.value} />
                      </div>
                    ) : (
                      <p className="break-all">{issue.value}</p>
                    )}
                  </div>
                )}
                {issue.recommendation && (
                  <div className="mt-3 rounded-lg bg-gradient-to-r from-sky-50 to-blue-50 border-2 border-sky-200 p-3">
                    <p className="text-sm font-semibold text-sky-900">💡 Anbefaling:</p>
                    <p className="mt-1 text-sm text-slate-700">{issue.recommendation}</p>
                  </div>
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

      {!loading && !result && !error && (
        <div className="text-center text-slate-500">
          <p>Ingen data tilgængelig</p>
        </div>
      )}
    </div>
  );
}
