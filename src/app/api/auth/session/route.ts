import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  ADMIN_SESSION_MAX_AGE_SECONDS,
  authorizeAdminRequest,
  createAdminSession,
  isAdminTokenConfigured,
  isSameOriginMutation,
  verifyAdminToken,
} from "@/lib/admin-auth";

const noStoreHeaders = { "Cache-Control": "no-store" };

function isSecureRequest(request: NextRequest): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return (forwardedProto || request.nextUrl.protocol.replace(":", "")) === "https";
}

export async function GET(request: NextRequest) {
  if (!isAdminTokenConfigured()) {
    return NextResponse.json(
      { configured: false, authenticated: false },
      { status: 503, headers: noStoreHeaders },
    );
  }

  const authorization = authorizeAdminRequest(request);
  return NextResponse.json(
    {
      configured: true,
      authenticated: authorization.ok,
      actorType: authorization.ok ? authorization.actor.actorType : null,
    },
    { status: authorization.ok ? 200 : 401, headers: noStoreHeaders },
  );
}

export async function POST(request: NextRequest) {
  if (!isAdminTokenConfigured()) {
    return NextResponse.json(
      { success: false, error: "管理员认证未配置" },
      { status: 503, headers: noStoreHeaders },
    );
  }
  if (!isSameOriginMutation(request)) {
    return NextResponse.json(
      { success: false, error: "跨站请求校验失败" },
      { status: 403, headers: noStoreHeaders },
    );
  }

  const body = await request.json().catch(() => ({})) as { token?: unknown };
  if (!verifyAdminToken(body.token)) {
    return NextResponse.json(
      { success: false, error: "管理员令牌无效" },
      { status: 401, headers: noStoreHeaders },
    );
  }

  const response = NextResponse.json({ success: true }, { headers: noStoreHeaders });
  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: createAdminSession(),
    httpOnly: true,
    sameSite: "strict",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: ADMIN_SESSION_MAX_AGE_SECONDS,
  });
  return response;
}

export async function DELETE(request: NextRequest) {
  if (!isSameOriginMutation(request)) {
    return NextResponse.json(
      { success: false, error: "跨站请求校验失败" },
      { status: 403, headers: noStoreHeaders },
    );
  }

  const response = NextResponse.json({ success: true }, { headers: noStoreHeaders });
  response.cookies.set({
    name: ADMIN_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });
  return response;
}
