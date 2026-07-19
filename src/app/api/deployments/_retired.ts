import { NextResponse } from "next/server";

function retired() {
  return NextResponse.json(
    { success: false, error: "旧部署 API 已停用，请使用统一管理控制台" },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = retired;
export const POST = retired;
