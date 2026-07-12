"use client";

import { useState, useRef, useEffect, useCallback } from "react";

interface MemoryEntry {
  id: number;
  memory_type: "short" | "long" | "rule";
  content: string;
  summary: string | null;
  keywords: string[] | null;
  score: number;
  original_id: string | null;
  created_at: string;
  compressed_at: string | null;
}

interface MemoryStats {
  [key: string]: { count: number; avgScore: number };
}

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  isCompressed?: boolean;
}

const SCORE_COLORS: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-500/20 text-amber-400",
  high: "bg-red-500/20 text-red-400",
};

function scoreClass(score: number): string {
  if (score >= 0.6) return SCORE_COLORS.high;
  if (score >= 0.3) return SCORE_COLORS.medium;
  return SCORE_COLORS.low;
}

function scoreLabel(score: number): string {
  if (score >= 0.8) return "关键";
  if (score >= 0.6) return "重要";
  if (score >= 0.3) return "一般";
  return "琐碎";
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "刚刚";
  if (mins < 60) return `${mins}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

export default function MemoryPage() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [showPanel, setShowPanel] = useState(true);
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [memoryStats, setMemoryStats] = useState<MemoryStats>({});
  const [conversationId] = useState("default");

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const loadMemories = useCallback(async () => {
    try {
      const res = await fetch(`/api/memory/entries?conversationId=${conversationId}`);
      const data = await res.json();
      if (data.success) {
        setMemories(data.entries || []);
        setMemoryStats(data.stats || {});
      }
    } catch {
      // ignore
    }
  }, [conversationId]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    const userMsg: ChatMsg = { role: "user", content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput("");
    setIsStreaming(true);

    // Build message history for API
    const allMessages = [...messages, userMsg].map(m => ({ role: m.role, content: m.content }));

    try {
      const res = await fetch("/api/memory/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, messages: allMessages }),
      });

      if (!res.ok) throw new Error("请求失败");

      const reader = res.body?.getReader();
      if (!reader) throw new Error("无响应流");

      const decoder = new TextDecoder();
      let assistantContent = "";
      let hasCompressed = false;
      setMessages(prev => [...prev, { role: "assistant", content: "" }]);

      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          try {
            const parsed = JSON.parse(payload);
            if (parsed.type === "content" && parsed.content) {
              assistantContent += parsed.content;
              setMessages(prev => {
                const updated = [...prev];
                updated[updated.length - 1] = { role: "assistant", content: assistantContent, isCompressed: hasCompressed };
                return updated;
              });
            } else if (parsed.type === "memory_meta") {
              hasCompressed = (parsed.compressedCount || 0) > 0;
            }
          } catch {
            // skip
          }
        }
      }

      // Reload memories after chat
      loadMemories();
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { role: "assistant", content: `抱歉，出了点问题：${err instanceof Error ? err.message : "未知错误"}` },
      ]);
    } finally {
      setIsStreaming(false);
      inputRef.current?.focus();
    }
  };

  const expandMemory = async (originalId: string) => {
    try {
      await fetch("/api/memory/entries", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originalId, conversationId }),
      });
      loadMemories();
    } catch {
      // ignore
    }
  };

  const deleteMemory = async (id: number) => {
    try {
      await fetch(`/api/memory/entries?id=${id}`, { method: "DELETE" });
      loadMemories();
    } catch {
      // ignore
    }
  };

  const shortMemories = memories.filter(m => m.memory_type === "short");
  const longMemories = memories.filter(m => m.memory_type === "long");
  const rules = memories.filter(m => m.memory_type === "rule");

  return (
    <div className="flex h-screen bg-[#0a0e17] text-foreground">
      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="border-b border-border px-6 py-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/20 flex items-center justify-center text-primary text-lg font-bold">
            M
          </div>
          <div>
            <h1 className="text-lg font-semibold">记忆管家</h1>
            <p className="text-xs text-muted-foreground">
              短期 {shortMemories.length} 条 | 压缩 {longMemories.length} 条 | 规则 {rules.length} 条
            </p>
          </div>
          <button
            onClick={() => setShowPanel(!showPanel)}
            className="ml-auto px-3 py-1.5 rounded-lg bg-muted text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            {showPanel ? "隐藏记忆库" : "查看记忆库"}
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center space-y-4 opacity-60">
              <div className="text-6xl">🧠</div>
              <h2 className="text-xl font-medium">我是你的私人记忆管家</h2>
              <p className="text-sm text-muted-foreground max-w-md">
                跟我说任何事情，我会自动评分、分类、压缩存档。<br />
                重要的事我绝不会忘，琐碎的事48小时后自动压缩。
              </p>
              <div className="flex gap-2 flex-wrap justify-center mt-4">
                {["帮我记住：每周五要交周报", "今天决定用Next.js重构项目", "明天下午3点有个重要会议"].map(s => (
                  <button
                    key={s}
                    onClick={() => { setInput(s); inputRef.current?.focus(); }}
                    className="px-3 py-2 rounded-lg bg-muted/50 text-sm hover:bg-muted transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((msg, i) => (
            <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-card border border-border"
                }`}
              >
                {msg.content}
                {msg.isCompressed && (
                  <div className="text-[10px] text-muted-foreground mt-2 border-t border-border pt-1">
                    【本次对话有记忆被压缩存档，可在记忆库面板查看】
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div className="border-t border-border px-6 py-4">
          <div className="flex gap-3 items-end">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="跟我说任何事情..."
              rows={2}
              className="flex-1 resize-none rounded-xl bg-card border border-border px-4 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground"
            />
            <button
              onClick={sendMessage}
              disabled={isStreaming || !input.trim()}
              className="px-5 py-3 rounded-xl bg-primary text-primary-foreground text-sm font-medium disabled:opacity-40 hover:bg-primary/90 transition-colors"
            >
              {isStreaming ? "思考中..." : "发送"}
            </button>
          </div>
        </div>
      </div>

      {/* Memory Panel */}
      {showPanel && (
        <div className="w-80 border-l border-border flex flex-col bg-card/30">
          <div className="px-4 py-3 border-b border-border">
            <h2 className="font-semibold text-sm">记忆库</h2>
            <div className="flex gap-3 mt-2 text-[11px]">
              {(["short", "long", "rule"] as const).map(type => {
                const s = memoryStats[type];
                const label = type === "short" ? "短期" : type === "long" ? "压缩" : "规则";
                return (
                  <span key={type} className="text-muted-foreground">
                    {label} {s?.count || 0}
                    {s && s.count > 0 && <span className="ml-1 opacity-60">均{s.avgScore.toFixed(1)}</span>}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {/* Rules */}
            {rules.length > 0 && (
              <div>
                <h3 className="text-[11px] font-medium text-amber-400 mb-2 uppercase tracking-wider">规则</h3>
                {rules.map(m => (
                  <div key={m.id} className="mb-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs">
                    <div className="flex justify-between items-start">
                      <span className="text-amber-300">{m.content}</span>
                      <button onClick={() => deleteMemory(m.id)} className="text-muted-foreground hover:text-destructive text-[10px] ml-1 shrink-0">x</button>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">{timeAgo(m.created_at)}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Short-term */}
            {shortMemories.length > 0 && (
              <div>
                <h3 className="text-[11px] font-medium text-emerald-400 mb-2 uppercase tracking-wider">短期记忆</h3>
                {shortMemories.map(m => (
                  <div key={m.id} className="mb-2 p-2 rounded-lg bg-emerald-500/5 border border-border text-xs">
                    <div className="flex justify-between items-start">
                      <span className="text-foreground/90 line-clamp-2">{m.content}</span>
                      <span className={`shrink-0 ml-2 px-1.5 py-0.5 rounded text-[10px] ${scoreClass(m.score)}`}>
                        {scoreLabel(m.score)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-[10px] text-muted-foreground">{timeAgo(m.created_at)}</span>
                      <button onClick={() => deleteMemory(m.id)} className="text-[10px] text-muted-foreground hover:text-destructive">x</button>
                    </div>
                    {m.keywords && m.keywords.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {m.keywords.slice(0, 4).map((kw, i) => (
                          <span key={i} className="px-1 py-0.5 rounded bg-muted text-[9px] text-muted-foreground">{kw}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Long-term (compressed) */}
            {longMemories.length > 0 && (
              <div>
                <h3 className="text-[11px] font-medium text-blue-400 mb-2 uppercase tracking-wider">压缩存档</h3>
                {longMemories.map(m => (
                  <div key={m.id} className="mb-2 p-2 rounded-lg bg-blue-500/5 border border-border text-xs">
                    <div className="text-foreground/70 line-clamp-2">{m.summary || m.content}</div>
                    <div className="flex justify-between items-center mt-1">
                      <span className="text-[10px] text-muted-foreground">
                        锚点 {m.original_id} | {m.compressed_at ? timeAgo(m.compressed_at) : ""}
                      </span>
                      <button
                        onClick={() => m.original_id && expandMemory(m.original_id)}
                        className="text-[10px] text-blue-400 hover:text-blue-300"
                      >
                        展开
                      </button>
                    </div>
                    {m.keywords && m.keywords.length > 0 && (
                      <div className="flex gap-1 mt-1 flex-wrap">
                        {m.keywords.slice(0, 4).map((kw, i) => (
                          <span key={i} className="px-1 py-0.5 rounded bg-muted text-[9px] text-muted-foreground">{kw}</span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            {memories.length === 0 && (
              <div className="text-center text-muted-foreground text-xs py-8">
                记忆库为空，开始聊天吧
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
