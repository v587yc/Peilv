import { expect, type APIRequestContext, type BrowserContext, type Page } from "@playwright/test";

export type SessionKind = "auditor" | "operator" | "super" | "expired" | "revoked";
export const VIRTUAL_SESSION_TOKENS: Record<SessionKind, string> = {
  auditor: "crow5-e2e-virtual-auditor-session-token",
  operator: "crow5-e2e-virtual-operator-session-token",
  super: "crow5-e2e-virtual-super-session-token",
  expired: "crow5-e2e-virtual-expired-session-token",
  revoked: "crow5-e2e-virtual-revoked-session-token",
};
export const VIRTUAL_INTERNAL_SECRET = "crow5_e2e_virtual_internal_secret_000000000000";
export const APP_ORIGIN = process.env.BASE_URL || "http://127.0.0.1:3100";
export const FAKE_DB_ORIGIN = "http://127.0.0.1:54329";

export async function useSession(context: BrowserContext, kind: SessionKind) {
  await context.clearCookies();
  await context.addCookies([{ name: "admin_session", value: VIRTUAL_SESSION_TOKENS[kind], url: APP_ORIGIN, httpOnly: true, sameSite: "Lax" }]);
}
export async function resetFakeDb(request: APIRequestContext) { await request.post(`${FAKE_DB_ORIGIN}/__reset`); }
export async function fakeDbState(request: APIRequestContext) {
  return await (await request.get(`${FAKE_DB_ORIGIN}/__state`)).json() as { mutations: number; auditMutations: number; businessMutations: number };
}
export function observeRuntime(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const productionRequests: string[] = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("requestfailed", request => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText || ""}`));
  page.on("request", request => {
    const host = new URL(request.url()).hostname;
    if (!host.startsWith("127.") && host !== "localhost") productionRequests.push(`${request.method()} ${request.url()}`);
  });
  return { consoleErrors, pageErrors, failedRequests, productionRequests };
}
export function expectCleanRuntime(runtime: ReturnType<typeof observeRuntime>) {
  expect(runtime.consoleErrors).toEqual([]);
  expect(runtime.pageErrors).toEqual([]);
  expect(runtime.failedRequests).toEqual([]);
  expect(runtime.productionRequests).toEqual([]);
}
