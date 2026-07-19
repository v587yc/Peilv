import { NextRequest } from "next/server";
import { legacyManagementWriteGone } from "@/features/management/legacy-write";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ version: string }> },
) {
  void request; void params;
  return legacyManagementWriteGone();
}
