import { strategyLabReadRoute } from "@/features/strategy-lab/admin-route";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) { const { id } = await context.params; return strategyLabReadRoute(request, service => service.getPrediction(id)); }
