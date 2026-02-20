import { getUrlsFromSitemap } from "./sitemap";
import {
  runAudit,
  type AuditResult,
  type AuditIssue,
  type FullSiteResult,
} from "./audit";
import { buildSuggestionsFromAggregated } from "./suggestions";

const BATCH_SIZE = 100; // Maksimal batch-størrelse for hurtigst mulig audit

function buildSuggestions(
  aggregated: AuditIssue[],
  _byKeyWithPages: Map<string, AuditIssue & { pages: string[] }>
) {
  return buildSuggestionsFromAggregated(aggregated);
}

export async function runFullSiteAudit(domain: string): Promise<FullSiteResult> {
  const origin = domain.startsWith("http") ? new URL(domain).origin : `https://${domain.replace(/^\s+|\s+$/g, "")}`;

  const { urlsToAudit, totalInSitemap } = await getUrlsFromSitemap(origin);

  const pages: AuditResult[] = [];
  const allIssues: AuditIssue[] = [];

  for (const url of urlsToAudit) {
    try {
      const result = await runAudit(url, url);
      if (result) {
        // Skip null (ikke-2xx sider)
        pages.push(result);
        for (const issue of result.issues) {
          allIssues.push({ ...issue, pageUrl: result.url });
        }
      }
    } catch {
      // Skip ved fejl
    }
  }

  const byKey = new Map<string, AuditIssue & { pages: string[] }>();
  for (const i of allIssues) {
    const key = `${i.category}|${i.severity}|${i.title}`;
    const existing = byKey.get(key);
    if (existing) {
      if (i.pageUrl && !existing.pages.includes(i.pageUrl)) existing.pages.push(i.pageUrl);
    } else {
      byKey.set(key, {
        ...i,
        pages: i.pageUrl ? [i.pageUrl] : [],
      });
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

  const improvementSuggestions = buildSuggestions(aggregated, byKey);

  return {
    origin,
    pages,
    aggregated,
    overallScore,
    categories,
    pagesAudited: pages.length,
    totalUrlsInSitemap: totalInSitemap,
    improvementSuggestions,
  };
}

/** Auditer en konkret liste af URLs (batch). Bruges når frontend henter hele sitemap og sender chunks. */
export async function runBatchAudit(urls: string[], origin: string): Promise<FullSiteResult> {
  const toAudit = urls.slice(0, BATCH_SIZE);
  // Kør audits parallelt for hurtigere gennemgang - skip ikke-2xx sider (returnerer null)
  const results = await Promise.all(toAudit.map(async (url) => {
    try {
      return await runAudit(url, url);
    } catch {
      return null; // Skip ved fejl
    }
  }));
  // Filtrer null væk (sider der ikke var 2xx eller fejlede)
  const pages: AuditResult[] = results.filter((r): r is AuditResult => r !== null);
  const allIssues: AuditIssue[] = [];

  for (const result of pages) {
    for (const issue of result.issues) {
      allIssues.push({ ...issue, pageUrl: result.url });
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
  const improvementSuggestions = buildSuggestions(aggregated, byKey);

  return {
    origin,
    pages,
    aggregated,
    overallScore,
    categories,
    pagesAudited: pages.length,
    totalUrlsInSitemap: toAudit.length,
    improvementSuggestions,
  };
}
