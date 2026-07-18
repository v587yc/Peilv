import { NextResponse } from "next/server";

const headers = { "Cache-Control": "no-store" };

function retired() {
  return NextResponse.json(
    {
      success: false,
      error: "旧部署认证已停用，请使用统一管理员登录",
      loginUrl: "/login?next=/admin/deployments",
    },
    { status: 410, headers },
  );
}

export const GET = retired;
export const POST = retired;
export const DELETE = retired;
