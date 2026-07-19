import { strategyLabReadRoute, strategyLabWriteRoute } from "@/features/strategy-lab/admin-route";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) { const { id } = await context.params; return strategyLabReadRoute(request, service => service.getRun(id)); }
export async function PATCH(request: Request, context: Context) { const { id } = await context.params; return strategyLabWriteRoute(request, { capability: "admin:execute", action: "strategy-lab.run.transition", objectType: "strategy_lab_run", successStatus: 200, execute: (service, body, actor) => service.transitionRun({ ...(body as object), id } as never, actor) }); }
