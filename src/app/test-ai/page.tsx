"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Loader2, CheckCircle, XCircle, Send, Zap, Save, Eye, EyeOff } from "lucide-react";

interface ConfigData {
  db: {
    llm_api_key: string;
    llm_base_url: string;
    llm_model: string;
    llm_web_search_enabled?: string;
    search_api_key: string;
    search_base_url: string;
  };
  env: {
    LLM_API_KEY: string;
    LLM_BASE_URL: string;
    LLM_MODEL: string;
    LLM_WEB_SEARCH?: string;
    COZE_SUPABASE_URL: string;
  };
  ready: boolean;
}

export default function TestAIPage() {
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [prompt, setPrompt] = useState("你好，请用一句话介绍自己。");
  const [result, setResult] = useState("");
  const [streamResult, setStreamResult] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamLoading, setStreamLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [showKey, setShowKey] = useState(false);

  // Form state
  const [formApiKey, setFormApiKey] = useState("");
  const [formBaseUrl, setFormBaseUrl] = useState("");
  const [formModel, setFormModel] = useState("");
  const [formSearchKey, setFormSearchKey] = useState("");
  const [formSearchUrl, setFormSearchUrl] = useState("");
  /** 启用模型联网搜索（Grok/OpenAI），默认开 */
  const [formWebSearchEnabled, setFormWebSearchEnabled] = useState(true);

  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/test-llm");
      const data = await res.json();
      setConfig(data);
      // Pre-fill form with DB values (or env fallbacks)
      if (data.db.llm_base_url) setFormBaseUrl(data.db.llm_base_url);
      else if (data.env.LLM_BASE_URL) setFormBaseUrl(data.env.LLM_BASE_URL);
      if (data.db.llm_model) setFormModel(data.db.llm_model);
      else if (data.env.LLM_MODEL) setFormModel(data.env.LLM_MODEL);
      if (data.db.search_base_url) setFormSearchUrl(data.db.search_base_url);
      // 模型联网：DB 已解析为 "true"/"false"，默认 true
      if (data.db?.llm_web_search_enabled != null) {
        setFormWebSearchEnabled(data.db.llm_web_search_enabled !== "false");
      } else {
        setFormWebSearchEnabled(true);
      }
    } catch {
      setConfig(null);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  // Save settings
  async function handleSave() {
    setSaving(true);
    setSaveMsg("");
    setError("");
    try {
      const payload: Record<string, string> = {
        // 联网开关始终随保存写入
        llm_web_search_enabled: formWebSearchEnabled ? "true" : "false",
      };
      if (formApiKey) payload.llm_api_key = formApiKey;
      if (formBaseUrl) payload.llm_base_url = formBaseUrl;
      if (formModel) payload.llm_model = formModel;
      if (formSearchKey) payload.search_api_key = formSearchKey;
      if (formSearchUrl) payload.search_base_url = formSearchUrl;

      const res = await fetch("/api/test-llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", ...payload }),
      });
      const data = await res.json();
      if (data.success) {
        setSaveMsg("保存成功！");
        setFormApiKey(""); // Clear sensitive input
        setFormSearchKey("");
        loadConfig(); // Refresh
      } else {
        setError(data.error || "保存失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  // Test non-streaming
  async function testInvoke() {
    setLoading(true);
    setResult("");
    setError("");
    setElapsed("");
    try {
      const res = await fetch("/api/test-llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", mode: "invoke", prompt }),
      });
      const data = await res.json();
      if (data.success) {
        setResult(data.content);
        setElapsed(data.elapsed);
      } else {
        setError(data.error);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败");
    } finally {
      setLoading(false);
    }
  }

  // Test streaming
  async function testStream() {
    setStreamLoading(true);
    setStreamResult("");
    setError("");
    try {
      const res = await fetch("/api/test-llm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", mode: "stream", prompt }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "请求失败" }));
        setError(data.error || `HTTP ${res.status}`);
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();

      let buffer = "";
      let streamDone = false;
      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") {
            streamDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(payload);
            if (parsed.error) setError(parsed.error);
            else if (parsed.content) setStreamResult((prev) => prev + parsed.content);
          } catch { /* skip */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "流式请求失败");
    } finally {
      setStreamLoading(false);
    }
  }

  const isReady = config?.ready;

  return (
    <div className="min-h-screen bg-[#0a0e17] text-gray-100 p-6">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">AI 接口配置</h1>
          {isReady ? (
            <Badge className="bg-emerald-600">已就绪</Badge>
          ) : (
            <Badge variant="destructive">未配置</Badge>
          )}
        </div>

        {/* 配置表单 */}
        <Card className="bg-[#111827] border-gray-700">
          <CardHeader>
            <CardTitle className="text-base">LLM 配置</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* API Key */}
            <div>
              <Label className="text-gray-400">
                API Key
                {config?.db.llm_api_key && (
                  <span className="ml-2 text-emerald-400 text-xs">(已保存: {config.db.llm_api_key})</span>
                )}
              </Label>
              <div className="relative mt-1">
                <Input
                  type={showKey ? "text" : "password"}
                  value={formApiKey}
                  onChange={(e) => setFormApiKey(e.target.value)}
                  className="bg-[#1a1f2e] border-gray-600 pr-10"
                  placeholder={config?.db.llm_api_key ? "留空则保持已有配置" : "sk-xxx"}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Base URL */}
            <div>
              <Label className="text-gray-400">Base URL</Label>
              <Input
                value={formBaseUrl}
                onChange={(e) => setFormBaseUrl(e.target.value)}
                className="mt-1 bg-[#1a1f2e] border-gray-600"
                placeholder="https://api.openai.com/v1"
              />
              <p className="text-xs text-gray-500 mt-1">
                OpenAI: api.openai.com/v1 | Deepseek: api.deepseek.com/v1 | 硅基流动: api.siliconflow.cn/v1
              </p>
            </div>

            {/* Model */}
            <div>
              <Label className="text-gray-400">模型名称</Label>
              <Input
                value={formModel}
                onChange={(e) => setFormModel(e.target.value)}
                className="mt-1 bg-[#1a1f2e] border-gray-600"
                placeholder="gpt-4o-mini"
              />
            </div>

            <Separator className="bg-gray-700" />
            <p className="text-xs text-gray-500">
              赛前新闻搜索：优先专用 Search API；未配置时仍可用「模型联网」（Grok/OpenAI 兼容中转）
            </p>

            {/* 模型联网搜索开关 */}
            <div className="flex items-start gap-3 rounded-md border border-gray-700 bg-[#1a1f2e]/60 px-3 py-3">
              <input
                id="llm-web-search-enabled"
                type="checkbox"
                checked={formWebSearchEnabled}
                onChange={(e) => setFormWebSearchEnabled(e.target.checked)}
                className="mt-1 h-4 w-4 rounded border-gray-600 bg-[#0a0e17] text-emerald-600 focus:ring-emerald-500"
              />
              <div className="flex-1">
                <Label htmlFor="llm-web-search-enabled" className="text-gray-200 cursor-pointer">
                  启用模型联网搜索（Grok/OpenAI）
                </Label>
                <p className="text-xs text-gray-500 mt-1">
                  默认开启。未配专用 Search API 时，AI 分析仍会用当前 LLM 做联网赛前新闻摘要（Responses / search_parameters / tools）。超时 20 秒，失败不阻塞分析。
                </p>
              </div>
            </div>

            {/* Search API Key */}
            <div>
              <Label className="text-gray-400">
                Search API Key（可选，专用搜索通道）
                {config?.db.search_api_key && (
                  <span className="ml-2 text-emerald-400 text-xs">(已保存: {config.db.search_api_key})</span>
                )}
              </Label>
              <Input
                type="password"
                value={formSearchKey}
                onChange={(e) => setFormSearchKey(e.target.value)}
                className="mt-1 bg-[#1a1f2e] border-gray-600"
                placeholder="留空则保持已有配置"
              />
            </div>

            {/* Search Base URL */}
            <div>
              <Label className="text-gray-400">Search Base URL（可选）</Label>
              <Input
                value={formSearchUrl}
                onChange={(e) => setFormSearchUrl(e.target.value)}
                className="mt-1 bg-[#1a1f2e] border-gray-600"
                placeholder="搜索 API 地址"
              />
            </div>

            {/* Save button */}
            <div className="flex items-center gap-3">
              <Button onClick={handleSave} disabled={saving} className="bg-emerald-600 hover:bg-emerald-700">
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Save className="w-4 h-4 mr-2" />}
                保存配置
              </Button>
              {saveMsg && <span className="text-emerald-400 text-sm">{saveMsg}</span>}
            </div>
          </CardContent>
        </Card>

        {/* 测试区域 */}
        <Card className="bg-[#111827] border-gray-700">
          <CardHeader>
            <CardTitle className="text-base">测试调用</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-gray-400">测试 Prompt</Label>
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="mt-1 bg-[#1a1f2e] border-gray-600"
                placeholder="输入测试内容..."
              />
            </div>
            <div className="flex gap-3">
              <Button onClick={testInvoke} disabled={loading || !isReady} className="bg-blue-600 hover:bg-blue-700">
                {loading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Send className="w-4 h-4 mr-2" />}
                普通调用
              </Button>
              <Button onClick={testStream} disabled={streamLoading || !isReady} className="bg-purple-600 hover:bg-purple-700">
                {streamLoading ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Zap className="w-4 h-4 mr-2" />}
                流式调用
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* 普通调用结果 */}
        {result && (
          <Card className="bg-[#111827] border-gray-700">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <CheckCircle className="w-4 h-4 text-emerald-400" />
                普通调用结果
                {elapsed && <Badge variant="outline" className="text-gray-400">{elapsed}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-200 whitespace-pre-wrap">{result}</p>
            </CardContent>
          </Card>
        )}

        {/* 流式调用结果 */}
        {streamResult && (
          <Card className="bg-[#111827] border-gray-700">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="w-4 h-4 text-purple-400" />
                流式调用结果
                {streamLoading && <Loader2 className="w-4 h-4 animate-spin text-purple-400" />}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-gray-200 whitespace-pre-wrap">{streamResult}</p>
            </CardContent>
          </Card>
        )}

        {/* 错误信息 */}
        {error && (
          <Card className="bg-[#111827] border-red-800">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2 text-red-400">
                <XCircle className="w-4 h-4" />
                错误
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-red-300 whitespace-pre-wrap text-sm">{error}</p>
            </CardContent>
          </Card>
        )}

        <Separator className="bg-gray-700" />
        <p className="text-xs text-gray-500">
          配置保存到数据库，优先级高于环境变量。保存后立即生效，无需重启服务。
        </p>
      </div>
    </div>
  );
}
