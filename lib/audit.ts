import * as cheerio from "cheerio";

export type Severity = "error" | "warning" | "pass";

export interface AuditIssue {
  id: string;
  category: string;
  severity: Severity;
  title: string;
  message: string;
  value?: string;
  recommendation?: string;
  pageUrl?: string;
}

export interface AuditResult {
  url: string;
  issues: AuditIssue[];
  score: number;
  categories: Record<string, { passed: number; failed: number; warnings: number }>;
}

export interface ImprovementSuggestion {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  recommendation: string;
  fixExample?: string;
  affectedCount: number;
}

export interface FullSiteResult {
  origin: string;
  pages: AuditResult[];
  aggregated: AuditIssue[];
  overallScore: number;
  categories: Record<string, { passed: number; failed: number; warnings: number }>;
  pagesAudited: number;
  totalUrlsInSitemap: number;
  improvementSuggestions: ImprovementSuggestion[];
}

function add(
  issues: AuditIssue[],
  category: string,
  severity: Severity,
  title: string,
  message: string,
  value?: string,
  recommendation?: string,
  pageUrl?: string
) {
  issues.push({
    id: `${category}-${issues.length}-${Math.random().toString(36).slice(2, 8)}`,
    category,
    severity,
    title,
    message,
    value,
    recommendation,
    pageUrl,
  });
}

export async function runAudit(url: string, pageUrl?: string): Promise<AuditResult> {
  const issues: AuditIssue[] = [];
  const categories: Record<string, { passed: number; failed: number; warnings: number }> = {};

  const normalizeUrl = url.startsWith("http") ? url : `https://${url}`;
  const baseUrl = new URL(normalizeUrl);
  const origin = baseUrl.origin;
  const path = baseUrl.pathname;

  let html: string;
  try {
    const res = await fetch(normalizeUrl, {
      headers: { "User-Agent": "SEO-Audit-Bot/1.0" },
    });
    if (!res.ok) {
      add(issues, "Teknisk", "error", "Siden svarer ikke", `HTTP ${res.status}`, undefined, "Tjek at URL er korrekt og siden er online.", pageUrl || normalizeUrl);
      return { url: normalizeUrl, issues, score: 0, categories };
    }
    html = await res.text();
  } catch (e) {
    add(issues, "Teknisk", "error", "Kunne ikke hente siden", String(e), undefined, "Tjek netværk og at domænet er tilgængeligt.", pageUrl || normalizeUrl);
    return { url: normalizeUrl, issues, score: 0, categories };
  }

  const $ = cheerio.load(html);

  // --- Title ---
  const title = $("title").text().trim();
  if (!title) {
    add(issues, "Titel & meta", "error", "Manglende sidetitel", "Der er ingen <title> tag.", undefined, "Tilføj en unik titel på 30–60 tegn.", normalizeUrl);
  } else {
    const len = title.length;
    if (len < 30) add(issues, "Titel & meta", "warning", "Titel for kort", `${len} tegn. Anbefaling: 30–60.`, title.slice(0, 50), "Forlæng titlen med nøgleord.", normalizeUrl);
    else if (len > 60) add(issues, "Titel & meta", "warning", "Titel for lang", `${len} tegn. Google afkorter ofte efter ca. 60.`, undefined, "Forkort titlen.", normalizeUrl);
    else add(issues, "Titel & meta", "pass", "Sidetitel OK", `${len} tegn.`, title, undefined, normalizeUrl);
  }

  // --- Meta description ---
  const metaDesc = $('meta[name="description"]').attr("content")?.trim();
  if (!metaDesc) {
    add(issues, "Titel & meta", "error", "Manglende metabeskrivelse", "Ingen meta name=\"description\".", undefined, "Tilføj en beskrivelse på 50–160 tegn.", normalizeUrl);
  } else {
    const len = metaDesc.length;
    if (len < 50) add(issues, "Titel & meta", "warning", "Metabeskrivelse for kort", `${len} tegn. Anbefaling: 50–160.`, undefined, "Skriv 1–2 sætninger der beskriver siden.", normalizeUrl);
    else if (len > 160) add(issues, "Titel & meta", "warning", "Metabeskrivelse for lang", `${len} tegn. Google viser ofte kun ca. 160.`, undefined, "Forkort til under 160 tegn.", normalizeUrl);
    else add(issues, "Titel & meta", "pass", "Metabeskrivelse OK", `${len} tegn.`, metaDesc.slice(0, 80) + "...", undefined, normalizeUrl);
  }

  // --- Viewport ---
  const viewport = $('meta[name="viewport"]').attr("content");
  if (!viewport) add(issues, "Mobil", "error", "Manglende viewport", "Siden kan vise forkert på mobil.", undefined, "Tilføj meta name=\"viewport\" content=\"width=device-width, initial-scale=1\".", normalizeUrl);
  else add(issues, "Mobil", "pass", "Viewport", "Sat.", undefined, undefined, normalizeUrl);

  // --- H1 ---
  const h1s = $("h1");
  const h1Count = h1s.length;
  if (h1Count === 0) {
    add(issues, "Overskrifter", "error", "Manglende H1", "Siden har ingen H1.", undefined, "Brug én H1 der beskriver sidens indhold.", normalizeUrl);
  } else if (h1Count > 1) {
    add(issues, "Overskrifter", "warning", "Flere H1'er", `Der er ${h1Count} H1'er. Anbefaling: 1.`, undefined, "Behold kun én H1 som hovedoverskrift.", normalizeUrl);
  } else {
    add(issues, "Overskrifter", "pass", "H1 OK", "Én H1.", h1s.first().text().trim().slice(0, 60), undefined, normalizeUrl);
  }

  // --- H2 / H3 ---
  const h2Count = $("h2").length;
  const h3Count = $("h3").length;
  if (h2Count === 0) add(issues, "Overskrifter", "warning", "Ingen H2'er", "H2 giver struktur og hjælper SEO.", undefined, "Brug H2 til underoverskrifter.", normalizeUrl);
  else add(issues, "Overskrifter", "pass", "H2-struktur", `${h2Count} H2'er${h3Count ? `, ${h3Count} H3'er` : ""}.`, undefined, undefined, normalizeUrl);

  // --- Sprog ---
  const lang = $("html").attr("lang");
  if (!lang) add(issues, "Teknisk", "warning", "Manglende sprog (lang)", "Ingen lang på <html>.", undefined, "Tilføj fx lang=\"da\".", normalizeUrl);
  else add(issues, "Teknisk", "pass", "Sprog angivet", `lang="${lang}"`, undefined, undefined, normalizeUrl);

  // --- Charset ---
  const charset = $("meta[charset]").attr("charset") || $('meta[http-equiv="Content-Type"]').attr("content");
  if (!charset && !$("meta[charset]").length) add(issues, "Teknisk", "warning", "Charset", "Anbefaling: UTF-8.", undefined, "Tilføj <meta charset=\"utf-8\">.", normalizeUrl);
  else add(issues, "Teknisk", "pass", "Charset", charset ? String(charset) : "Fundet", undefined, undefined, normalizeUrl);

  // --- Canonical ---
  const canonical = $('link[rel="canonical"]').attr("href");
  if (!canonical) add(issues, "Links & canonical", "warning", "Ingen canonical URL", "Kan give duplicate content.", undefined, "Tilføj link rel=\"canonical\" med sidens endelige URL.", normalizeUrl);
  else add(issues, "Links & canonical", "pass", "Canonical OK", canonical, undefined, undefined, normalizeUrl);

  // --- Meta robots ---
  const robots = $('meta[name="robots"]').attr("content");
  if (robots && /noindex/i.test(robots)) add(issues, "Crawl", "warning", "Noindex", "Siden må ikke indekseres.", robots, "Fjern noindex hvis siden skal ranke.", normalizeUrl);
  else if (!robots || !/noindex/i.test(robots)) add(issues, "Crawl", "pass", "Index tilladt", "Siden kan indekseres.", undefined, undefined, normalizeUrl);

  // --- Open Graph ---
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDesc = $('meta[property="og:description"]').attr("content");
  const ogImage = $('meta[property="og:image"]').attr("content");
  if (!ogTitle) add(issues, "Social (OG)", "warning", "Manglende og:title", "Vises når siden deles.", undefined, "Tilføj meta property=\"og:title\".", normalizeUrl);
  else add(issues, "Social (OG)", "pass", "og:title", ogTitle.slice(0, 50), undefined, undefined, normalizeUrl);
  if (!ogDesc) add(issues, "Social (OG)", "warning", "Manglende og:description", "Vises ved deling.", undefined, "Tilføj meta property=\"og:description\".", normalizeUrl);
  else add(issues, "Social (OG)", "pass", "og:description", "Sat", undefined, undefined, normalizeUrl);
  if (!ogImage) add(issues, "Social (OG)", "warning", "Manglende og:image", "Ingen forhåndsvisning ved deling.", undefined, "Tilføj meta property=\"og:image\".", normalizeUrl);
  else add(issues, "Social (OG)", "pass", "og:image", "Sat", undefined, undefined, normalizeUrl);

  // --- Twitter cards ---
  const twCard = $('meta[name="twitter:card"]').attr("content");
  if (!twCard) add(issues, "Social (Twitter)", "warning", "Manglende twitter:card", "Vises ved deling på Twitter/X.", undefined, "Tilføj meta name=\"twitter:card\" content=\"summary_large_image\".", normalizeUrl);
  else add(issues, "Social (Twitter)", "pass", "Twitter card", "Sat", undefined, undefined, normalizeUrl);

  // --- Billeder ---
  const imgs = $("img");
  const imgsWithoutAlt = imgs.filter((_, el) => !$(el).attr("alt")).length;
  const totalImgs = imgs.length;
  const imgsWithoutDimensions = imgs.filter((_, el) => !$(el).attr("width") && !$(el).attr("height")).length;
  if (totalImgs > 0 && imgsWithoutAlt > 0) {
    add(issues, "Billeder", "error", "Billeder uden alt-tekst", `${imgsWithoutAlt} af ${totalImgs} mangler alt.`, undefined, "Tilføj alt på alle billeder.", normalizeUrl);
  } else if (totalImgs > 0) {
    add(issues, "Billeder", "pass", "Alt-tekst på billeder", `Alle ${totalImgs} har alt.`, undefined, undefined, normalizeUrl);
  }
  if (totalImgs > 0 && imgsWithoutDimensions === totalImgs) add(issues, "Billeder", "warning", "Billeder uden mål", "Width/height kan reducere CLS.", undefined, "Overvej width/height på img.", normalizeUrl);
  else if (totalImgs > 0 && imgsWithoutDimensions > 0) add(issues, "Billeder", "pass", "Billedmål", `${totalImgs - imgsWithoutDimensions} med mål.`, undefined, undefined, normalizeUrl);

  // --- Links ---
  const links = $("a[href]");
  const internal = links.filter((_, el) => {
    const href = $(el).attr("href") || "";
    return href.startsWith("/") || href.startsWith(origin);
  }).length;
  const external = links.length - internal;
  const linksEmptyHref = links.filter((_, el) => !$(el).attr("href")?.trim() || $(el).attr("href") === "#").length;
  if (linksEmptyHref > 0) add(issues, "Links & canonical", "warning", "Links med tom eller # href", `${linksEmptyHref} stk.`, undefined, "Brug rigtige URLs eller button.", normalizeUrl);
  add(issues, "Links & canonical", "pass", "Links", `${internal} interne, ${external} eksterne.`, undefined, undefined, normalizeUrl);

  // --- Indholdslængde ---
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;
  if (wordCount < 100) add(issues, "Indhold", "warning", "Lidt tekst", `Ca. ${wordCount} ord. Anbefaling: 300+ for indholdsrige sider.`, undefined, "Tilføj mere unikt indhold.", normalizeUrl);
  else if (wordCount < 300) add(issues, "Indhold", "pass", "Tekstmængde", `Ca. ${wordCount} ord.`, undefined, undefined, normalizeUrl);
  else add(issues, "Indhold", "pass", "God tekstmængde", `Ca. ${wordCount} ord.`, undefined, undefined, normalizeUrl);

  // --- JSON-LD / strukturerede data ---
  const jsonLd = $('script[type="application/ld+json"]');
  if (jsonLd.length === 0) add(issues, "Strukturerede data", "warning", "Ingen JSON-LD", "Kan forbedre visning i søgning.", undefined, "Overvej Organization eller Product schema.", normalizeUrl);
  else add(issues, "Strukturerede data", "pass", "JSON-LD fundet", `${jsonLd.length} blok(ke).`, undefined, undefined, normalizeUrl);

  // --- Favicon ---
  const favicon = $('link[rel="icon"], link[rel="shortcut icon"]').attr("href");
  if (!favicon) add(issues, "Teknisk", "warning", "Manglende favicon", "Ingen favicon link.", undefined, "Tilføj link rel=\"icon\".", normalizeUrl);
  else add(issues, "Teknisk", "pass", "Favicon", "Fundet", undefined, undefined, normalizeUrl);

  // --- URL ---
  if (path.length > 80) add(issues, "URL", "warning", "Lang URL", `${path.length} tegn.`, path, "Forkort URL for læsbarhed.", normalizeUrl);
  if (path !== path.toLowerCase()) add(issues, "URL", "warning", "Store bogstaver i URL", "Anbefaling: kun små bogstaver.", path, "Brug lowercase URLs.", normalizeUrl);
  add(issues, "URL", "pass", "URL", path || "/", undefined, undefined, normalizeUrl);

  // --- robots.txt (kun én gang per origin) ---
  if (!pageUrl || pageUrl === normalizeUrl) {
    try {
      const robotsRes = await fetch(`${origin}/robots.txt`, { headers: { "User-Agent": "SEO-Audit-Bot/1.0" } });
      if (!robotsRes.ok) add(issues, "Crawl", "warning", "robots.txt", "Kunne ikke hentes.", undefined, "Tilføj /robots.txt.", normalizeUrl);
      else {
        const robotsTxt = await robotsRes.text();
        const hasSitemap = /Sitemap:\s*https?:/i.test(robotsTxt);
        if (!hasSitemap) add(issues, "Crawl", "warning", "Sitemap i robots.txt", "Ingen Sitemap angivet.", undefined, "Tilføj Sitemap: URL i robots.txt.", normalizeUrl);
        else add(issues, "Crawl", "pass", "robots.txt & sitemap", "Sitemap angivet.", undefined, undefined, normalizeUrl);
      }
    } catch {
      add(issues, "Crawl", "warning", "robots.txt", "Kunne ikke hentes.", undefined, "Sikr at /robots.txt er tilgængelig.", normalizeUrl);
    }
  }

  // --- HTTPS ---
  if (!normalizeUrl.startsWith("https://")) add(issues, "Sikkerhed", "error", "Ikke HTTPS", "Siden bruger ikke HTTPS.", undefined, "Aktiver SSL/HTTPS.", normalizeUrl);
  else add(issues, "Sikkerhed", "pass", "HTTPS", "Aktiveret.", undefined, undefined, normalizeUrl);

  // --- Kategorier & score ---
  for (const i of issues) {
    if (!categories[i.category]) categories[i.category] = { passed: 0, failed: 0, warnings: 0 };
    if (i.severity === "pass") categories[i.category].passed++;
    else if (i.severity === "error") categories[i.category].failed++;
    else categories[i.category].warnings++;
  }
  const total = issues.length;
  const passed = issues.filter((i) => i.severity === "pass").length;
  const score = total > 0 ? Math.round((passed / total) * 100) : 0;

  return { url: normalizeUrl, issues, score, categories };
}
