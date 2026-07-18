import { NextResponse } from "next/server";
import { isProductionBuildReady } from "@/lib/readiness";

const headers = { "Cache-Control": "no-store" };

export async function GET() {
  const ready = await isProductionBuildReady();
  return NextResponse.json({ ready }, { status: ready ? 200 : 503, headers });
}
