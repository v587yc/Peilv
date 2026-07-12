import Link from "next/link";
import packageJson from "../../package.json";

const buildSha = process.env.GITHUB_SHA || process.env.VERCEL_GIT_COMMIT_SHA || "";
const appVersion = `${packageJson.version}${buildSha ? ` · ${buildSha.slice(0, 7)}` : ""}`;

const entries = [
  {
    title: "赔率监控",
    href: "/odds",
    description: "实时赛事、公司赔率、AI 分析、验证学习入口。",
    tag: "主入口",
    accent: "border-blue-500/30 text-blue-300",
  },
  {
    title: "AI 配置",
    href: "/test-ai",
    description: "配置 LLM API、模型、搜索接口，并测试普通/流式调用。",
    tag: "配置",
    accent: "border-violet-500/30 text-violet-300",
  },
  {
    title: "学习系统 / 回测",
    href: "/backtest",
    description: "批量回测历史赛事，验证预测结果并触发模式学习。",
    tag: "学习",
    accent: "border-emerald-500/30 text-emerald-300",
  },
  {
    title: "记忆系统",
    href: "/memory",
    description: "查看和调试记忆库、压缩摘要与对话记忆。",
    tag: "记忆",
    accent: "border-amber-500/30 text-amber-300",
  },
];

export default function Home() {
  return (
    <main className="min-h-dvh bg-background text-foreground">
      <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-10">
        <header className="mb-8">
          <div className="text-xs font-semibold tracking-[0.28em] text-primary">PEILV INTELLIGENCE</div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">实时赔率监控系统</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            常用页面入口集中在这里；如果只想看赛事，直接进入赔率监控。
          </p>
        </header>

        <section className="grid gap-4 sm:grid-cols-2">
          {entries.map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className={`group rounded-xl border bg-card/80 p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${entry.accent}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-lg font-semibold text-foreground group-hover:text-current">{entry.title}</div>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">{entry.description}</p>
                </div>
                <span className="rounded-full border border-current/30 px-2 py-0.5 text-[10px] font-medium">
                  {entry.tag}
                </span>
              </div>
              <div className="mt-5 text-xs font-medium text-muted-foreground transition-colors group-hover:text-foreground">
                打开 {entry.href} <span className="ml-1 transition group-hover:translate-x-1">→</span>
              </div>
            </Link>
          ))}
        </section>

        <footer className="mt-auto flex flex-wrap items-center justify-between gap-3 pt-10 text-xs text-muted-foreground">
          <span>入口页不会自动跳转；需要默认打开监控时使用 <Link href="/odds" className="text-cyan-400 hover:text-cyan-300">/odds</Link>。</span>
          <span className="rounded-full border border-border bg-card px-3 py-1 font-mono text-[11px] text-foreground">版本 v{appVersion}</span>
        </footer>
      </div>
    </main>
  );
}
