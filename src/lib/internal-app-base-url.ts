const DEFAULT_INTERNAL_PORT = "3000";

export function getInternalAppBaseUrl(): string {
  const configured = process.env.INTERNAL_APP_BASE_URL?.trim()
    || `http://127.0.0.1:${process.env.PORT || DEFAULT_INTERNAL_PORT}`;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error("INTERNAL_APP_BASE_URL配置无效");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("INTERNAL_APP_BASE_URL必须是纯origin");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (process.env.NODE_ENV === "production" && (!loopback || url.protocol !== "http:")) {
    throw new Error("生产环境INTERNAL_APP_BASE_URL必须使用HTTP loopback");
  }
  if (!loopback) throw new Error("INTERNAL_APP_BASE_URL必须指向loopback");
  return url.origin;
}
