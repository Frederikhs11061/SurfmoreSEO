import type { AuditIssue, ImprovementSuggestion, Severity } from "./audit";

/** Eksempler på konkrete rettelser – bruges både server og client */
export const FIX_EXAMPLES: Record<string, string> = {
  "Manglende sidetitel": '<title>Din sidetitel her (30-60 tegn) | Brand</title>',
  "Manglende metabeskrivelse": '<meta name="description" content="Beskrivelse af siden, 50-160 tegn.">',
  "Titel for kort": "Tilføj nøgleord og brand, fx: Produktnavn – Kort beskrivelse | SURFMORE",
  "Titel for lang": "Fjern ord så titlen er under 60 tegn. Google afkorter i søgeresultater.",
  "Metabeskrivelse for kort": "Skriv 1-2 sætninger der beskriver indholdet og opfordrer til klik.",
  "Metabeskrivelse for lang": "Forkort til max 160 tegn. Behold call-to-action og nøgleord.",
  "Manglende viewport": '<meta name="viewport" content="width=device-width, initial-scale=1">',
  "Manglende H1": "Brug én <h1> med sidens hovedtema, fx: <h1>Kategori eller produktnavn</h1>",
  "Flere H1'er": "Behold kun én H1. Brug H2 til underoverskrifter.",
  "Ingen H2'er": "Opdel indhold med <h2> underoverskrifter for bedre læsbarhed og SEO.",
  "Manglende sprog (lang)": '<html lang="da">',
  "Manglende canonical URL": '<link rel="canonical" href="https://ditdomæne.dk/denne-side">',
  "Manglende og:title": '<meta property="og:title" content="Samme som eller udvidet titel">',
  "Manglende og:description": '<meta property="og:description" content="Kort tekst til deling">',
  "Manglende og:image": '<meta property="og:image" content="https://ditdomæne.dk/billede.jpg">',
  "Manglende twitter:card": '<meta name="twitter:card" content="summary_large_image">',
  "Billeder uden alt-tekst": '<img src="x.jpg" alt="Beskrivelse af billedet">',
  "Billeder uden mål": 'Overvej width og height på <img> for at undgå layout-skift.',
  "Ingen canonical URL": '<link rel="canonical" href="{{ canonical_url }}">',
  "Ingen JSON-LD": "Tilføj script type=\"application/ld+json\" med Organization eller Product schema.",
  "Manglende favicon": '<link rel="icon" href="/favicon.ico" sizes="32x32">',
  "Lang URL": "Brug korte, læsbare URLs. Fjern unødvendige parametre.",
  "Store bogstaver i URL": "Brug kun små bogstaver i URLs (fx /produkt-navn).",
  "robots.txt": "Opret filen /robots.txt med Sitemap: https://ditdomæne.dk/sitemap.xml",
  "Sitemap i robots.txt": "Tilføj linje: Sitemap: https://ditdomæne.dk/sitemap.xml",
  "Ikke HTTPS": "Aktiver SSL-certifikat hos din hosting (Let's Encrypt eller hostings eget).",
  "Noindex": "Fjern noindex fra meta robots hvis siden skal indekseres.",
};

/** Byg forbedringsforslag ud fra aggregerede issues (kan køres på client ved merge). */
export function buildSuggestionsFromAggregated(aggregated: AuditIssue[]): ImprovementSuggestion[] {
  const list: ImprovementSuggestion[] = [];
  let id = 0;
  for (const i of aggregated) {
    if (i.severity === "pass") continue;
    const affectedCount =
      i.pageUrl && i.pageUrl.includes(" sider")
        ? parseInt(i.pageUrl, 10) || 1
        : 1;
    list.push({
      id: `sug-${++id}`,
      title: i.title,
      severity: i.severity as Severity,
      category: i.category,
      recommendation: i.recommendation || i.message,
      fixExample: FIX_EXAMPLES[i.title],
      affectedCount,
    });
  }
  list.sort((a, b) =>
    a.severity === "error" && b.severity !== "error"
      ? -1
      : b.severity === "error" && a.severity !== "error"
        ? 1
        : 0
  );
  return list;
}
