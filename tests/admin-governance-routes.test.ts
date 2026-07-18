import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const calls=vi.hoisted(()=>[] as Array<{action:string}>);
vi.mock("@/lib/auth/admin-capabilities",()=>({
  requireAdminCapability:()=>({
    ok:true,
    principal:{actorId:"admin-1",actorType:"admin",capabilities:["admin:view","admin:configure","admin:execute","admin:dangerous"]},
  }),
}));
vi.mock("@/features/management/route-command",()=>({CommandRateLimitError:class extends Error{},runRouteCommand:async(_request:Request,_principal:unknown,action:string)=>{calls.push({action});return NextResponse.json({success:true,replayed:false});}}));
vi.mock("@/features/management/commands",()=>({CommandConflictError:class extends Error{}}));
vi.mock("@/storage/database/supabase-client",()=>({getSupabaseClient:()=>({from:()=>({select:()=>({order:()=>({limit:async()=>({data:[],error:null})})})})})}));

import { PATCH as strategyLifecycle } from "@/app/api/admin/strategies/route";
import { POST as backtestLifecycle } from "@/app/api/admin/backtests/route";
import { PATCH as settingsReplace } from "@/app/api/admin/settings/route";
import { POST as automationCompensate } from "@/app/api/admin/automation/route";

describe("admin governance command routes",()=>{beforeEach(()=>{calls.length=0;});it("routes every mutation through the persistent command boundary",async()=>{const request=(url:string,method:string)=>new NextRequest(url,{method,headers:{"content-type":"application/json"},body:"{}"});expect((await strategyLifecycle(request("http://local/api/admin/strategies","PATCH"))).status).toBe(200);expect((await backtestLifecycle(request("http://local/api/admin/backtests","POST"))).status).toBe(200);expect((await settingsReplace(request("http://local/api/admin/settings","PATCH"))).status).toBe(200);expect((await automationCompensate(request("http://local/api/admin/automation","POST"))).status).toBe(200);expect(calls.map(call=>call.action)).toEqual(["strategy.lifecycle","backtest.lifecycle","settings.replace","automation.compensate"]);});});
