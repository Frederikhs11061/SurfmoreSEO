import { NextRequest } from "next/server";
import { runAudit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = (body.url || "surfmore.dk").toString().trim();
    if (!url) {
      return Response.json({ error: "URL mangler" }, { status: 400 });
    }
    const result = await runAudit(url);
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
}
