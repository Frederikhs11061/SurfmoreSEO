/**
 * Client-side SEO audit - bruger browser's native DOM API i stedet for cheerio
 */

import type { AuditResult, AuditIssue, Severity } from "./audit";

function add(
  issues: AuditIssue[],
  category: string,
  severity: Severity,
  title: string,
  message: string,
  value?: string,
  recommendation?: string,
  url?: string
) {
  const id = `${category}-${title}`.toLowerCase().replace(/\s+/g, "-");
  issues.push({ id, category, severity, title, message, value, recommendation, pageUrl: url });
}

export async function runAuditClient(url: string, pageUrl?: string): Promise<AuditResult> {
  const issues: AuditIssue[] = [];
  const categories: Record<string, { passed: number; failed: number; warnings: number }> = {};

  const normalizeUrl = url.startsWith("http") ? url : `https://${url}`;
  const baseUrl = new URL(normalizeUrl);
  const origin = baseUrl.origin;

  let html: string;
  let httpStatus: number = 0;
  try {
    const res = await fetch(normalizeUrl, {
      headers: { "User-Agent": "SEO-Audit-Bot/1.0" },
      mode: "cors",
    });
    httpStatus = res.status;
    if (!res.ok || res.status < 200 || res.status >= 300) {
      return null as any;
    }
    html = await res.text();
  } catch (e) {
    return null as any;
  }

  // Parse HTML med browser's native DOMParser
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  // Helper funktioner til at query DOM
  const query = (selector: string) => doc.querySelector(selector);
  const queryAll = (selector: string) => Array.from(doc.querySelectorAll(selector));
  const getText = (selector: string) => query(selector)?.textContent?.trim() || "";
  const getAttr = (selector: string, attr: string) => query(selector)?.getAttribute(attr)?.trim();

  // --- Title ---
  const title = getText("title");
  if (!title) {
    add(issues, "Titel & meta", "error", "Manglende sidetitel", "Der er ingen <title> tag.", undefined, "Tilføj en unik titel på 30–60 tegn.", normalizeUrl);
  } else {
    const len = title.length;
    if (len < 30) add(issues, "Titel & meta", "warning", "Titel for kort", `${len} tegn. Anbefaling: 30–60.`, title.slice(0, 50), "Forlæng titlen med nøgleord.", normalizeUrl);
    else if (len > 60) add(issues, "Titel & meta", "warning", "Titel for lang", `${len} tegn. Google afkorter ofte efter ca. 60.`, undefined, "Forkort titlen.", normalizeUrl);
    else add(issues, "Titel & meta", "pass", "Sidetitel OK", `${len} tegn.`, title, undefined, normalizeUrl);
  }

  // --- Meta description ---
  const metaDesc = getAttr('meta[name="description"]', "content");
  if (!metaDesc) {
    add(issues, "Titel & meta", "error", "Manglende meta description", "Der er ingen meta description.", undefined, "Tilføj en meta description på 120–160 tegn.", normalizeUrl);
  } else {
    const len = metaDesc.length;
    if (len < 120) add(issues, "Titel & meta", "warning", "Meta description for kort", `${len} tegn. Anbefaling: 120–160.`, metaDesc.slice(0, 80), "Forlæng meta description.", normalizeUrl);
    else if (len > 160) add(issues, "Titel & meta", "warning", "Meta description for lang", `${len} tegn. Google afkorter ofte efter ca. 160.`, undefined, "Forkort meta description.", normalizeUrl);
    else add(issues, "Titel & meta", "pass", "Meta description OK", `${len} tegn.`, metaDesc, undefined, normalizeUrl);
  }

  // --- H1 ---
  const h1s = queryAll("h1");
  if (h1s.length === 0) {
    add(issues, "Overskrifter", "error", "Manglende H1", "Der er ingen H1 tag.", undefined, "Tilføj én H1 med hovednøgleord.", normalizeUrl);
  } else if (h1s.length > 1) {
    add(issues, "Overskrifter", "warning", "Flere H1 tags", `${h1s.length} H1 tags fundet. Anbefaling: 1.`, h1s.slice(0, 3).map(h => h.textContent?.trim()).filter(Boolean).join(", "), "Brug kun én H1 per side.", normalizeUrl);
  } else {
    add(issues, "Overskrifter", "pass", "H1 OK", "Én H1 tag fundet.", h1s[0].textContent?.trim(), undefined, normalizeUrl);
  }

  // --- H2-H3 ---
  const h2s = queryAll("h2");
  const h3s = queryAll("h3");
  if (h2s.length === 0 && h3s.length === 0) {
    add(issues, "Overskrifter", "warning", "Ingen H2/H3 tags", "Ingen underoverskrifter fundet.", undefined, "Tilføj H2/H3 tags for bedre struktur.", normalizeUrl);
  } else {
    add(issues, "Overskrifter", "pass", "Underoverskrifter OK", `${h2s.length} H2, ${h3s.length} H3.`, undefined, undefined, normalizeUrl);
  }

  // --- Viewport ---
  const viewport = getAttr('meta[name="viewport"]', "content");
  if (!viewport) {
    add(issues, "Teknisk SEO", "error", "Manglende viewport meta tag", "Ingen viewport tag fundet.", undefined, "Tilføj: <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">", normalizeUrl);
  } else {
    add(issues, "Teknisk SEO", "pass", "Viewport OK", "Viewport meta tag fundet.", viewport, undefined, normalizeUrl);
  }

  // --- Canonical ---
  const canonical = getAttr('link[rel="canonical"]', "href");
  if (!canonical) {
    add(issues, "Links & canonical", "warning", "Manglende canonical tag", "Ingen canonical URL fundet.", undefined, "Tilføj canonical tag for at undgå duplicate content.", normalizeUrl);
  } else {
    add(issues, "Links & canonical", "pass", "Canonical OK", "Canonical tag fundet.", canonical, undefined, normalizeUrl);
  }

  // --- Open Graph ---
  const ogTitle = getAttr('meta[property="og:title"]', "content");
  const ogDesc = getAttr('meta[property="og:description"]', "content");
  const ogImage = getAttr('meta[property="og:image"]', "content");
  if (!ogTitle) add(issues, "Social (OG)", "warning", "Manglende OG title", "Ingen og:title fundet.", undefined, "Tilføj Open Graph title.", normalizeUrl);
  else add(issues, "Social (OG)", "pass", "OG title OK", "og:title fundet.", ogTitle, undefined, normalizeUrl);
  if (!ogDesc) add(issues, "Social (OG)", "warning", "Manglende OG description", "Ingen og:description fundet.", undefined, "Tilføj Open Graph description.", normalizeUrl);
  else add(issues, "Social (OG)", "pass", "OG description OK", "og:description fundet.", ogDesc, undefined, normalizeUrl);
  if (!ogImage) add(issues, "Social (OG)", "warning", "Manglende OG image", "Ingen og:image fundet.", undefined, "Tilføj Open Graph image.", normalizeUrl);
  else add(issues, "Social (OG)", "pass", "OG image OK", "og:image fundet.", ogImage, undefined, normalizeUrl);

  // --- Twitter Cards ---
  const twitterCard = getAttr('meta[name="twitter:card"]', "content");
  if (!twitterCard) {
    add(issues, "Social (Twitter)", "warning", "Manglende Twitter card", "Ingen twitter:card fundet.", undefined, "Tilføj Twitter card meta tags.", normalizeUrl);
  } else {
    add(issues, "Social (Twitter)", "pass", "Twitter card OK", "twitter:card fundet.", twitterCard, undefined, normalizeUrl);
  }

  // --- Billeder ---
  const imgs = queryAll("img");
  const imagesWithoutAlt: string[] = [];
  imgs.forEach((img) => {
    const alt = img.getAttribute("alt")?.trim();
    let src = img.getAttribute("src") || img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || "";
    
    // Konverter relative URL'er til absolutte URL'er
    if (src && !src.startsWith("http") && !src.startsWith("//") && !src.startsWith("data:")) {
      try {
        if (src.startsWith("/")) {
          src = `${origin}${src}`;
        } else {
          src = new URL(src, normalizeUrl).href;
        }
      } catch {
        // Hvis URL parsing fejler, brug original
      }
    } else if (src && src.startsWith("//")) {
      src = `https:${src}`;
    }
    
    if (!alt || alt.trim() === "") {
      imagesWithoutAlt.push(src || "ukendt kilde");
    }
  });
  const totalImgs = imgs.length;
  const imgsWithoutDimensions = imgs.filter(img => !img.getAttribute("width") && !img.getAttribute("height")).length;
  if (totalImgs > 0 && imagesWithoutAlt.length > 0) {
    const imgList = imagesWithoutAlt.join(", ");
    add(issues, "Billeder", "error", "Billeder uden alt-tekst", `${imagesWithoutAlt.length} af ${totalImgs} mangler alt.`, imgList, "Tilføj alt på alle billeder.", normalizeUrl);
  } else if (totalImgs > 0) {
    add(issues, "Billeder", "pass", "Alt-tekst på billeder", `Alle ${totalImgs} har alt.`, undefined, undefined, normalizeUrl);
  }
  if (totalImgs > 0 && imgsWithoutDimensions === totalImgs) add(issues, "Billeder", "warning", "Billeder uden mål", "Width/height kan reducere CLS.", undefined, "Overvej width/height på img.", normalizeUrl);
  else if (totalImgs > 0 && imgsWithoutDimensions > 0) add(issues, "Billeder", "pass", "Billedmål", `${totalImgs - imgsWithoutDimensions} med mål.`, undefined, undefined, normalizeUrl);

  // --- Links (simplificeret analyse) ---
  const links = queryAll("a[href]");
  const internalLinks: Array<{ url: string; anchorText: string; hasNoFollow: boolean; isImageLink: boolean }> = [];
  const externalLinks: string[] = [];
  const linksEmptyHref: string[] = [];
  const linksWithoutAnchorText: string[] = [];
  
  links.forEach((link) => {
    const href = link.getAttribute("href") || "";
    const text = link.textContent?.trim() || link.getAttribute("aria-label")?.trim() || "";
    const rel = link.getAttribute("rel") || "";
    const isImageLink = link.querySelector("img") !== null;
    
    if (!href.trim() || href === "#" || href.startsWith("javascript:")) {
      linksEmptyHref.push(href || "(tom)");
      return;
    }
    
    const isInternal = href.startsWith("/") || href.startsWith(origin) || (!href.startsWith("http") && !href.startsWith("mailto:") && !href.startsWith("tel:"));
    const fullUrl = isInternal && !href.startsWith("http") ? new URL(href, origin).href : href;
    
    if (isInternal) {
      internalLinks.push({
        url: fullUrl,
        anchorText: text || (isImageLink ? (link.querySelector("img")?.getAttribute("alt") || "Billede-link") : "Ingen tekst"),
        hasNoFollow: rel.includes("nofollow"),
        isImageLink,
      });
      
      if (!text && !isImageLink) {
        linksWithoutAnchorText.push(fullUrl);
      }
    } else if (href.startsWith("http")) {
      externalLinks.push(href);
    }
  });
  
  // Analyse interne links
  if (linksEmptyHref.length > 0) {
    add(issues, "Links & canonical", "error", "Links med tom eller ugyldig href", `${linksEmptyHref.length} links med tom, # eller javascript: href.`, linksEmptyHref.slice(0, 5).join(", "), "Brug rigtige URLs eller button-elementer i stedet.", normalizeUrl);
  }
  
  if (internalLinks.length === 0 && externalLinks.length === 0 && linksEmptyHref.length === 0) {
    add(issues, "Links & canonical", "warning", "Ingen links fundet", "Ingen links på siden.", undefined, "Tilføj interne og eksterne links.", normalizeUrl);
  } else {
    if (internalLinks.length > 0) {
      add(issues, "Links & canonical", "pass", "Interne links", `${internalLinks.length} interne links fundet.`, undefined, undefined, normalizeUrl);
    }
    if (externalLinks.length > 0) {
      const externalWithoutRel = externalLinks.filter((_, idx) => {
        const link = links[idx];
        return link && !link.getAttribute("rel")?.includes("nofollow") && !link.getAttribute("rel")?.includes("noopener");
      });
      if (externalWithoutRel.length > 0) {
        add(issues, "Links & canonical", "warning", "Eksterne links mangler rel-attributter", `${externalWithoutRel.length} eksterne links mangler rel=\"nofollow\" eller rel=\"noopener\".`, undefined, "Tilføj rel=\"nofollow noopener\" til eksterne links.", normalizeUrl);
      } else {
        add(issues, "Links & canonical", "pass", "Eksterne links", `${externalLinks.length} eksterne links med korrekt rel-attributter.`, undefined, undefined, normalizeUrl);
      }
    }
  }
  
  if (linksWithoutAnchorText.length > 0) {
    add(issues, "Links & canonical", "warning", "Links uden anchor tekst", `${linksWithoutAnchorText.length} links mangler anchor tekst.`, linksWithoutAnchorText.slice(0, 5).join(", "), "Tilføj tekst eller aria-label til links.", normalizeUrl);
  }

  // --- Strukturerede data (JSON-LD) ---
  const jsonLdScripts = queryAll('script[type="application/ld+json"]');
  if (jsonLdScripts.length === 0) {
    add(issues, "Strukturerede data", "warning", "Ingen strukturerede data", "Ingen JSON-LD fundet.", undefined, "Overvej at tilføje strukturerede data (Schema.org).", normalizeUrl);
  } else {
    add(issues, "Strukturerede data", "pass", "Strukturerede data OK", `${jsonLdScripts.length} JSON-LD script(s) fundet.`, undefined, undefined, normalizeUrl);
  }

  // --- Favicon ---
  const favicon = query('link[rel="icon"], link[rel="shortcut icon"]');
  if (!favicon) {
    add(issues, "Teknisk SEO", "warning", "Manglende favicon", "Ingen favicon fundet.", undefined, "Tilføj favicon link tag.", normalizeUrl);
  } else {
    add(issues, "Teknisk SEO", "pass", "Favicon OK", "Favicon fundet.", favicon.getAttribute("href") || "", undefined, normalizeUrl);
  }

  // --- URL struktur ---
  const urlPath = baseUrl.pathname;
  if (urlPath.length > 100) {
    add(issues, "URL struktur", "warning", "URL for lang", `${urlPath.length} tegn. Korte URLs er bedre.`, urlPath, "Forkort URL strukturen.", normalizeUrl);
  } else {
    add(issues, "URL struktur", "pass", "URL struktur OK", `${urlPath.length} tegn.`, urlPath, undefined, normalizeUrl);
  }

  // --- HTTPS ---
  if (baseUrl.protocol === "https:") {
    add(issues, "Sikkerhed", "pass", "HTTPS", "Siden bruger HTTPS.", undefined, undefined, normalizeUrl);
  } else {
    add(issues, "Sikkerhed", "error", "Manglende HTTPS", "Siden bruger ikke HTTPS.", undefined, "Skift til HTTPS.", normalizeUrl);
  }

  // --- Robots.txt ---
  try {
    const robotsRes = await fetch(`${origin}/robots.txt`);
    if (robotsRes.ok) {
      add(issues, "Teknisk SEO", "pass", "Robots.txt", "robots.txt fundet.", undefined, undefined, normalizeUrl);
    } else {
      add(issues, "Teknisk SEO", "warning", "Manglende robots.txt", "Ingen robots.txt fundet.", undefined, "Overvej at tilføje robots.txt.", normalizeUrl);
    }
  } catch {
    add(issues, "Teknisk SEO", "warning", "Manglende robots.txt", "Kunne ikke hente robots.txt.", undefined, "Overvej at tilføje robots.txt.", normalizeUrl);
  }

  // --- Indhold (tekstmængde) ---
  const bodyText = doc.body?.textContent || "";
  const wordCount = bodyText.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < 300) {
    add(issues, "Indhold", "warning", "Tekstmængde", `${wordCount} ord. Anbefaling: 300+.`, undefined, "Tilføj mere indhold.", normalizeUrl);
  } else {
    add(issues, "Indhold", "pass", "God tekstmængde", `${wordCount} ord.`, undefined, undefined, normalizeUrl);
  }

  // --- EEAT (simplificeret) ---
  const authorMeta = getAttr('meta[name="author"]', "content");
  const author = authorMeta || undefined;
  const hasAuthorBio = /bio|om mig|about/i.test(bodyText) || query('[itemtype*="Person"]') !== null;
  const hasExpertise = /ekspert|expert|erfaring|experience|kompetence/i.test(bodyText);
  const hasTrustworthiness = /kontakt|contact|adresse|address|cvr|cvr-nr|telefon|phone/i.test(bodyText) ||
                              queryAll('[itemtype*="ContactPoint"], .contact, [class*="contact"]').length > 0;
  const hasAboutPage = queryAll('a[href*="/om"], a[href*="/about"], a[href*="/om-os"]').length > 0;
  const hasContactInfo = queryAll('a[href*="mailto:"], a[href*="tel:"], [itemtype*="ContactPoint"]').length > 0;

  const eeat = {
    author: author || undefined,
    authorBio: hasAuthorBio,
    expertise: hasExpertise,
    trustworthiness: hasTrustworthiness || hasContactInfo,
    aboutPage: hasAboutPage,
    contactInfo: hasContactInfo,
  };

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

  return { url: normalizeUrl, issues, score, categories, imagesWithoutAlt, eeat };
}

// Batch audit client-side - returnerer samme format som server-side
export async function runBatchAuditClient(url: string, origin: string): Promise<AuditResult | null> {
  try {
    return await runAuditClient(url, url);
  } catch {
    return null; // Returner null ved fejl (fx CORS)
  }
}
