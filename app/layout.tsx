import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SEO Audit | SURFMORE",
  description: "Teknisk SEO-audit af din side – titel, meta, overskrifter, billeder og mere.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="da">
      <body className="min-h-screen bg-gradient-to-br from-sky-50 via-blue-50 to-cyan-50 text-slate-900 antialiased">
        {children}
      </body>
    </html>
  );
}
