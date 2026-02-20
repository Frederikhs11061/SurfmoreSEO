/** SEO-piller: gruppering af audit-kategorier */
export const SEO_PILLARS = ["Teknisk SEO", "On-page SEO", "Link building"] as const;
export type SEOPillar = (typeof SEO_PILLARS)[number];

/** Map fra audit-kategori til pille */
export const categoryToPillar: Record<string, SEOPillar> = {
  Teknisk: "Teknisk SEO",
  Crawl: "Teknisk SEO",
  Sikkerhed: "Teknisk SEO",
  URL: "Teknisk SEO",
  Mobil: "Teknisk SEO",
  "Titel & meta": "On-page SEO",
  Overskrifter: "On-page SEO",
  Billeder: "On-page SEO",
  Indhold: "On-page SEO",
  "Strukturerede data": "On-page SEO",
  "Social (OG)": "On-page SEO",
  "Social (Twitter)": "On-page SEO",
  EEAT: "On-page SEO",
  "Links & canonical": "Link building",
};

export function getPillarForCategory(category: string): SEOPillar {
  return categoryToPillar[category] ?? "On-page SEO";
}
