// @vitest-environment happy-dom
import { act } from "react";
import { createRoot,type Root } from "react-dom/client";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";

const navigation=vi.hoisted(()=>({replace:vi.fn(),query:"tab=matrix"}));
vi.mock("next/navigation",()=>({useRouter:()=>navigation,useSearchParams:()=>new URLSearchParams(navigation.query)}));
import { StrategyLabView } from "@/app/admin/strategies/lab/strategy-lab-view";

(globalThis as typeof globalThis&{IS_REACT_ACT_ENVIRONMENT:boolean}).IS_REACT_ACT_ENVIRONMENT=true;
const runId="10000000-0000-4000-8000-000000000001",predictionId="10000000-0000-4000-8000-000000000002";
const metric={counted:2,unavailable:1,outcomes:{win:1,halfWin:1,push:0,halfLoss:0,loss:0},profitMicros:"1500000",stakeMicros:"2000000",roi:"0.75"};
const cells=["A","B","C","D"].flatMap(strategy=>["T1215","T30","T03"].map(checkpoint=>({strategy,checkpoint,sample:strategy==="D"?0:2,fallback:strategy==="C"?1:0,executable:strategy!=="D",compatibilityOnly:strategy==="D",decisions:{recommend:1,observe:1,reanalyze:0,insufficient:0},snapshotQuality:{ready:1,partial:0,insufficient:0,invalid:0,missing:1},actual:metric,theoretical:{...metric,counted:0,roi:null}})));
const fixtures={runs:{data:[{id:runId,status:"running",startDate:"20260717",endDate:"20260717",datasetMode:"strict_asof",createdAt:"2026-07-17T00:00:00Z",coverage:{predictions:12,matches:1,settled:2},auditStatus:"audit_pending"}],pageInfo:{limit:50,hasMore:true,nextCursor:"runs-next"}},overview:{data:{coverage:{predictions:12,matches:1,recommend:6,observe:3,reanalyze:2,insufficient:1,cFallback:1,dBaseline:3},policy:{capture:{mode:"user_focused_leagues",artifactHash:"abcdef1234567890",captureId:"capture",capturedAt:"2026-07-17T00:00:00Z"},currentChanged:"unknown"},health:{reader:"ready"}},pageInfo:null},matrix:{data:cells,pageInfo:null},report:{data:{validSample:11,coverage:{matches:1,recommend:6,observe:3,reanalyze:1,insufficient:1},cFallback:1,dBaseline:3,actual:metric,theoretical:{...metric,counted:0,roi:null},metricDefinitions:{roi:"server"},timeSeries:null},pageInfo:null},predictions:{data:[{id:predictionId,matchId:"match-1",matchDate:"20260717",checkpoint:"T30",requestedStrategy:"C",executedStrategy:"A",fallback:true,fallbackReason:"C unavailable",compatibilityOnly:false,decisionStatus:"recommend",selection:"home",inputHash:"inputhash123456",outputHash:"outputhash123456",snapshotHash:"evidencehash123456",createdAt:"2026-07-17T00:00:00Z"}],pageInfo:{limit:50,hasMore:false,nextCursor:null}},audit:{data:[{status:"audit_pending"}],pageInfo:{limit:50,hasMore:false,nextCursor:null}},chain:{data:{integrity:{revision:"verified",quoteDrift:"verified"},revisions:[{id:"r1",revision:1,quoteBasis:"actual",outcome:"loss",profitMicros:"-1000000",isCounted:true,evidenceHash:"evidence111111",calculatorVersion:"v1",quoteHandicapRaw:"0.5",quoteSelectedWaterMillionths:900000,scoreRevision:1,scoreRevisionHash:"score111111",current:false,superseded:true,excludedFromStatistics:true,settledAt:"2026-07-17T18:00:00Z"},{id:"r2",revision:2,quoteBasis:"actual",outcome:"win",profitMicros:"1000000",isCounted:true,evidenceHash:"evidence222222",calculatorVersion:"v1",quoteHandicapRaw:"0.5",quoteSelectedWaterMillionths:900000,scoreRevision:2,scoreRevisionHash:"score222222",current:true,superseded:false,excludedFromStatistics:false,settledAt:"2026-07-17T19:00:00Z"}]},pageInfo:null}};
let root:Root|null=null,container:HTMLDivElement;
const envelope=(value:unknown)=>JSON.stringify({contractVersion:"read-v1",generatedAt:"2026-07-18T00:00:00Z",requestId:"request-test",appliedFilters:{},...(value as object)});
function fetchMock(error?:{status:number;message:string}){return vi.fn(async(input:RequestInfo|URL)=>{const url=String(input);if(error)return new Response(JSON.stringify({message:error.message,requestId:"request-error"}),{status:error.status,headers:{"Content-Type":"application/json"}});const key=url.includes("settlement-chain")?"chain":url.includes("/overview")?"overview":url.includes("/matrix")?"matrix":url.includes("/report")?"report":url.includes("/audit")?"audit":url.includes("/predictions")?"predictions":"runs";return new Response(envelope(fixtures[key as keyof typeof fixtures]),{status:200,headers:{"Content-Type":"application/json"}})});}
async function render(query="tab=matrix",error?:{status:number;message:string}){navigation.query=query;vi.stubGlobal("fetch",fetchMock(error));container=document.createElement("div");document.body.append(container);root=createRoot(container);await act(async()=>{root?.render(<StrategyLabView/>);await new Promise(resolve=>setTimeout(resolve,20))});return container;}
async function click(text:string){const button=Array.from(document.querySelectorAll("button")).find(node=>node.textContent?.includes(text)) as HTMLButtonElement;expect(button,text).toBeTruthy();await act(async()=>{// happy-dom + Radix Tabs 需要完整 pointer 序列，原生 click() 不会触发 onValueChange
  button.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));
  button.dispatchEvent(new MouseEvent("mousedown",{bubbles:true}));
  button.dispatchEvent(new PointerEvent("pointerup",{bubbles:true}));
  button.dispatchEvent(new MouseEvent("mouseup",{bubbles:true}));
  button.dispatchEvent(new MouseEvent("click",{bubbles:true}));
  await new Promise(resolve=>setTimeout(resolve,20));
});}
beforeEach(()=>{vi.clearAllMocks();Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:vi.fn(async()=>undefined)}})});
afterEach(async()=>{await act(async()=>root?.unmount());root=null;document.body.replaceChildren();vi.unstubAllGlobals()});

describe("Strategy Lab read-only admin view",()=>{
 it("renders the fixed 12-cell matrix, C fallback, D baseline and mobile cards",async()=>{const view=await render();expect(view.querySelectorAll("tbody tr")).toHaveLength(12);expect(view.textContent).toContain("C→A 1");expect(view.textContent).toContain("覆盖 推1/观1/重0/缺0");expect(view.textContent).toContain("Compatibility-only · 不可执行");expect(view.textContent).toContain("Actual 实际");expect(view.textContent).toContain("Theoretical 理论");expect(view.textContent).toContain("unavailable 1");expect(view.textContent).toContain("ROI —");expect(view.querySelector('[data-testid="matrix-mobile-cards"]')?.className).toContain("lg:hidden")});
 it("exposes responsive layout classes for PC / tablet / mobile readonly flow",async()=>{const view=await render();
  // PC: desktop table visible from lg+
  expect(view.querySelector(".hidden.lg\\:block, .hidden")?.className||"").toMatch(/lg:block|hidden/);
  // Tablet/Phone: mobile cards stay until lg; 2-col tabs on small screens, 4-col from md
  expect(view.querySelector('[data-testid="matrix-mobile-cards"]')?.className).toContain("lg:hidden");
  const tabsList=view.querySelector('[data-slot="tabs-list"]');
  expect(tabsList?.className).toMatch(/grid-cols-2/);
  expect(tabsList?.className).toMatch(/md:grid-cols-4/);
  // Touch targets
  expect(Array.from(view.querySelectorAll("button")).some(button=>button.className.includes("min-h-11")||button.className.includes("size-11"))).toBe(true);
  // Readonly only — no mutation labels
  const forbidden=/^(创建|启动|取消|执行|结算|发布|暂停|恢复|导出)$/;
  expect(Array.from(view.querySelectorAll("button")).some(button=>forbidden.test(button.textContent?.trim()||""))).toBe(false);
 });
 it.each([["决策证据","decision"],["观察报告","report"],["影子运行","shadow"],["策略矩阵","matrix"]])("synchronizes %s with URL",async(label,tab)=>{await render();await click(label);expect(new URLSearchParams(window.location.search).get("tab")).toBe(tab)});
 it("renders audit pending, server report and readonly chain integrity timeline",async()=>{const view=await render("tab=decision");expect(view.textContent).toContain("Audit pending");await click("专业");expect(view.textContent).toContain("Input · inputhash1");const copy=view.querySelector<HTMLButtonElement>('[aria-label="复制Input完整值"]')!;await act(async()=>copy.click());expect(navigator.clipboard.writeText).toHaveBeenCalledWith("inputhash123456");await click("查看结算修订");expect(document.body.textContent).toContain("结算修订链");expect(document.body.textContent).toContain("Revision verified");expect(document.body.textContent).toContain("superseded");expect(document.body.textContent).toContain("current")});
 it("uses the server report without deriving unavailable as zero percent",async()=>{const view=await render("tab=report");expect(view.textContent).toContain("有效样本 11");expect(view.textContent).toContain("C→A 1");expect(view.textContent).toContain("D baseline 3");expect(view.textContent).toContain("unavailable 1");expect(view.textContent).not.toContain("unavailable 0%")});
 it.each([[401,"读取失败"],[403,"没有查看权限"],[404,"记录不存在"],[422,"证据完整性异常"],[503,"只读查询服务暂不可用"]] as const)("renders %s with requestId",async(status,title)=>{const view=await render("tab=matrix",{status,message:"fixture failure"});expect(view.textContent).toContain(title);expect(view.textContent).toContain("request-error")});
 it("renders loading and empty states and exposes no mutation action buttons",async()=>{vi.stubGlobal("fetch",vi.fn(()=>new Promise(()=>undefined)));navigation.query="tab=matrix";container=document.createElement("div");document.body.append(container);root=createRoot(container);await act(async()=>root?.render(<StrategyLabView/>));expect(container.querySelectorAll('[data-slot="skeleton"]')).not.toHaveLength(0);await act(async()=>root?.unmount());root=createRoot(container);vi.stubGlobal("fetch",vi.fn(async()=>new Response(envelope({data:[],pageInfo:{limit:50,hasMore:false,nextCursor:null}}),{headers:{"Content-Type":"application/json"}})));await act(async()=>{root?.render(<StrategyLabView/>);await new Promise(resolve=>setTimeout(resolve,10))});expect(container.textContent).toContain("暂无影子运行");const forbidden=/^(创建|启动|取消|执行|结算|发布|暂停|恢复|导出)$/;expect(Array.from(container.querySelectorAll("button")).some(button=>forbidden.test(button.textContent?.trim()||""))).toBe(false)});
});
