import { getUrlsFromSitemap } from "./sitemap";
import { runAudit, type AuditResult, type AuditIssue, type FullSiteResult } from "./audit";

const MAX_PAGES = 8;

export async function runFullSiteAudit(domain: string): Promise<FullSiteResult> {
  const origin = domain.startsWith("http") ? new URL(domain).origin : `https://${domain.replace(/^\s+|\s+$/g, "")}`;
  const urls = await getUrlsFromSitemap(origin);
  const toAudit = urls.length ? urls.slice(0, MAX_PAGES) : [origin + "/"];

  const pages: AuditResult[] = [];
  const allIssues: AuditIssue[] = [];

  for (const url of toAudit) {
    const result = await runAudit(url, url);
    pages.push(result);
    for (const issue of result.issues) {
      allIssues.push({ ...issue, pageUrl: result.url });
    }
  }

  // Aggreger: gruppér efter title+category+severity, behold unikke med pageUrl-liste
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

  return {
    origin,
    pages,
    aggregated,
    overallScore,
    categories,
    pagesAudited: pages.length,
  };
}
