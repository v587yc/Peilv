import { NextResponse } from "next/server";

const headers = {
  "Cache-Control": "private, no-store",
  Deprecation: "true",
  Link: '</api/admin>; rel="successor-version"',
};

/**
 * Retired management mutations must fail before parsing input or touching a
 * repository. Keeping this response centralized makes the zero-side-effect
 * contract explicit and consistent across legacy routes.
 */
export function legacyManagementWriteGone() {
  return NextResponse.json({
    success: false,
    error: "该管理写入口已停用，请使用 /api/admin/* 命令接口",
    errorCode: "LEGACY_MANAGEMENT_WRITE_GONE",
  }, { status: 410, headers });
}
