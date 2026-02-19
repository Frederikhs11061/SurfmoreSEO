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
}

export interface AuditResult {
  url: string;
  issues: AuditIssue[];
  score: number;
  categories: Record<string, { passed: number; failed: number; warnings: number }>;
}

function add(
  issues: AuditIssue[],
  category: string,
  severity: Severity,
  title: string,
  message: string,
  value?: string,
  recommendation?: string
) {
  issues.push({
    id: `${category}-${issues.length}`,
    category,
    severity,
    title,
    message,
    value,
    recommendation,
  });
}

export async function runAudit(url: string): Promise<AuditResult> {
  const issues: AuditIssue[] = [];
  const categories: Record<string, { passed: number; failed: number; warnings: number }> = {};

  const normalizeUrl = url.startsWith("http") ? url : `https://${url}`;
  const baseUrl = new URL(normalizeUrl);
  const origin = baseUrl.origin;

  let html: string;
  try {
    const res = await fetch(normalizeUrl, {
      headers: { "User-Agent": "SEO-Audit-Bot/1.0" },
    });
    if (!res.ok) {
      add(issues, "Teknisk", "error", "Siden svarer ikke", `HTTP ${res.status}`, undefined, "Tjek at URL er korrekt og siden er online.");
      return { url: normalizeUrl, issues, score: 0, categories };
    }
    html = await res.text();
  } catch (e) {
    add(issues, "Teknisk", "error", "Kunne ikke hente siden", String(e), undefined, "Tjek netværk og at domænet er tilgængeligt.");
    return { url: normalizeUrl, issues, score: 0, categories };
  }

  const $ = cheerio.load(html);

  // --- Title ---
  const title = $("title").text().trim();
  if (!title) {
    add(issues, "Titel & meta", "error", "Manglende sidetitel", "Der er ingen <title> tag.", undefined, "Tilføj en unik titel på 30–60 tegn.");
  } else {
    const len = title.length;
    if (len < 30) add(issues, "Titel & meta", "warning", "Titel for kort", `${len} tegn. Anbefaling: 30–60.`, `${title}`, "Forlæng titlen med nøgleord.");
    else if (len > 60) add(issues, "Titel & meta", "warning", "Titel for lang", `${len} tegn. Google afkorter ofte efter ca. 60.`, undefined, "Forkort titlen.");
    else add(issues, "Titel & meta", "pass", "Sidetitel OK", `${len} tegn.`, title);
  }

  // --- Meta description ---
  const metaDesc = $('meta[name="description"]').attr("content")?.trim();
  if (!metaDesc) {
    add(issues, "Titel & meta", "error", "Manglende metabeskrivelse", "Ingen meta name=\"description\".", undefined, "Tilføj en beskrivelse på 50–160 tegn.");
  } else {
    const len = metaDesc.length;
    if (len < 50) add(issues, "Titel & meta", "warning", "Metabeskrivelse for kort", `${len} tegn. Anbefaling: 50–160.`, undefined, "Skriv 1–2 sætninger der beskriver siden.");
    else if (len > 160) add(issues, "Titel & meta", "warning", "Metabeskrivelse for lang", `${len} tegn. Google viser ofte kun ca. 160.`, undefined, "Forkort til under 160 tegn.");
    else add(issues, "Titel & meta", "pass", "Metabeskrivelse OK", `${len} tegn.`, metaDesc.slice(0, 80) + "...");
  }

  // --- H1 ---
  const h1s = $("h1");
  const h1Count = h1s.length;
  if (h1Count === 0) {
    add(issues, "Overskrifter", "error", "Manglende H1", "Siden har ingen H1.", undefined, "Brug én H1 der beskriver sidens indhold.");
  } else if (h1Count > 1) {
    add(issues, "Overskrifter", "warning", "Flere H1'er", `Der er ${h1Count} H1'er. Anbefaling: 1.`, undefined, "Behold kun én H1 som hovedoverskrift.");
  } else {
    add(issues, "Overskrifter", "pass", "H1 OK", "Én H1.", h1s.first().text().trim().slice(0, 60));
  }

  // --- H2 ---
  const h2Count = $("h2").length;
  if (h2Count === 0) add(issues, "Overskrifter", "warning", "Ingen H2'er", "H2 giver struktur og hjælper SEO.", undefined, "Brug H2 til underoverskrifter.");
  else add(issues, "Overskrifter", "pass", "H2-struktur", `${h2Count} H2'er.`, undefined);

  // --- Sprog ---
  const lang = $("html").attr("lang");
  if (!lang) add(issues, "Teknisk", "warning", "Manglende sprog (lang)", "Ingen lang på <html>.", undefined, "Tilføj fx lang=\"da\".");
  else add(issues, "Teknisk", "pass", "Sprog angivet", `lang="${lang}"`, undefined);

  // --- Charset ---
  const charset = $("meta[charset]").attr("charset") || $('meta[http-equiv="Content-Type"]').attr("content");
  if (!charset && !$("meta[charset]").length) add(issues, "Teknisk", "warning", "Charset", "Anbefaling: UTF-8.", undefined, "Tilføj <meta charset=\"utf-8\">.");
  else add(issues, "Teknisk", "pass", "Charset", charset ? String(charset) : "Fundet", undefined);

  // --- Canonical ---
  const canonical = $('link[rel="canonical"]').attr("href");
  if (!canonical) add(issues, "Links & canonical", "warning", "Ingen canonical URL", "Kan give duplicate content.", undefined, "Tilføj link rel=\"canonical\" med sidens endelige URL.");
  else add(issues, "Links & canonical", "pass", "Canonical OK", canonical, undefined);

  // --- Open Graph ---
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDesc = $('meta[property="og:description"]').attr("content");
  const ogImage = $('meta[property="og:image"]').attr("content");
  if (!ogTitle) add(issues, "Social (OG)", "warning", "Manglende og:title", "Vises når siden deles.", undefined, "Tilføj meta property=\"og:title\".");
  else add(issues, "Social (OG)", "pass", "og:title", ogTitle.slice(0, 50), undefined);
  if (!ogDesc) add(issues, "Social (OG)", "warning", "Manglende og:description", "Vises ved deling på sociale medier.", undefined, "Tilføj meta property=\"og:description\".");
  else add(issues, "Social (OG)", "pass", "og:description", "Sat", undefined);
  if (!ogImage) add(issues, "Social (OG)", "warning", "Manglende og:image", "Ingen forhåndsvisning ved deling.", undefined, "Tilføj meta property=\"og:image\" med billed-URL.");
  else add(issues, "Social (OG)", "pass", "og:image", "Sat", undefined);

  // --- Billeder ---
  const imgs = $("img");
  const imgsWithoutAlt = imgs.filter((_, el) => !$(el).attr("alt")).length;
  const totalImgs = imgs.length;
  if (totalImgs > 0 && imgsWithoutAlt > 0) {
    add(issues, "Billeder", "error", "Billeder uden alt-tekst", `${imgsWithoutAlt} af ${totalImgs} billeder mangler alt.`, undefined, "Tilføj alt på alle billeder (beskrivelse for SEO og tilgængelighed).");
  } else if (totalImgs > 0) {
    add(issues, "Billeder", "pass", "Alt-tekst på billeder", `Alle ${totalImgs} har alt.`, undefined);
  }

  // --- Links ---
  const links = $("a[href]");
  const internal = links.filter((_, el) => {
    const href = $(el).attr("href") || "";
    return href.startsWith("/") || href.startsWith(origin);
  }).length;
  const external = links.length - internal;
  add(issues, "Links & canonical", "pass", "Links", `${internal} interne, ${external} eksterne.`, undefined);

  // --- robots.txt ---
  try {
    const robotsRes = await fetch(`${origin}/robots.txt`);
    if (!robotsRes.ok) add(issues, "Crawl", "warning", "robots.txt", "Kunne ikke hentes.", undefined, "Tilføj /robots.txt.");
    else {
      const robotsTxt = await robotsRes.text();
      const hasSitemap = /Sitemap:\s*https?:/i.test(robotsTxt);
      if (!hasSitemap) add(issues, "Crawl", "warning", "Sitemap i robots.txt", "Ingen Sitemap: angivet.", undefined, "Tilføj Sitemap: URL i robots.txt.");
      else add(issues, "Crawl", "pass", "robots.txt & sitemap", "Sitemap angivet.", undefined);
    }
  } catch {
    add(issues, "Crawl", "warning", "robots.txt", "Kunne ikke hentes.", undefined, "Sikr at /robots.txt er tilgængelig.");
  }

  // --- HTTPS ---
  if (!normalizeUrl.startsWith("https://")) add(issues, "Sikkerhed", "error", "Ikke HTTPS", "Siden bruger ikke HTTPS.", undefined, "Aktiver SSL/HTTPS.");
  else add(issues, "Sikkerhed", "pass", "HTTPS", "Aktiveret.", undefined);

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
