#!/usr/bin/env node
import { createInterface, emitKeypressEvents } from "node:readline";
import process from "node:process";

const DEFAULT_URL = "http://127.0.0.1:5000";

function bootstrapBaseUrl(rawValue) {
  let url;
  try { url = new URL(rawValue); }
  catch { throw new Error("ADMIN_BOOTSTRAP_BASE_URL 必须是有效的 HTTP(S) URL"); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("ADMIN_BOOTSTRAP_BASE_URL 只允许 http 或 https 协议");
  if (url.username || url.password || url.search || url.hash) throw new Error("ADMIN_BOOTSTRAP_BASE_URL 禁止包含凭据、查询参数或片段");
  if (url.pathname !== "/") throw new Error("ADMIN_BOOTSTRAP_BASE_URL 只能配置 origin，不允许附加路径");
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!loopbackHosts.has(url.hostname)) {
    if (url.protocol !== "https:" || process.env.ADMIN_BOOTSTRAP_ALLOW_REMOTE_HTTPS !== "true") {
      throw new Error("远程初始化只允许 HTTPS，并需显式设置 ADMIN_BOOTSTRAP_ALLOW_REMOTE_HTTPS=true 确认安全边界");
    }
  }
  return url;
}

function promptText(question, { optional = false } = {}) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => terminal.question(question, answer => {
    terminal.close();
    resolve(optional ? answer.trim() : answer.trim());
  }));
}

function promptHidden(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("当前终端不支持隐藏输入；请通过受保护的环境变量提供 token，并在交互终端运行此命令");
  }
  process.stdout.write(question);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener("keypress", onKeypress);
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onKeypress = (character, key = {}) => {
      if (key.ctrl && key.name === "c") return finish(new Error("已取消初始化"));
      if (key.name === "return" || key.name === "enter") return finish();
      if (key.name === "backspace") { value = value.slice(0, -1); return; }
      if (!key.ctrl && !key.meta && character) value += character;
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function requiredText(question) {
  while (true) {
    const value = await promptText(question);
    if (value) return value;
    process.stderr.write("该字段不能为空。\n");
  }
}

async function main() {
  if (process.argv.length > 2) throw new Error("此命令不接受参数，避免凭据进入 argv 或 shell history");
  const baseUrl = bootstrapBaseUrl(process.env.ADMIN_BOOTSTRAP_BASE_URL || DEFAULT_URL);
  const bootstrapToken = process.env.ADMIN_BOOTSTRAP_TOKEN || await promptHidden("Bootstrap token（隐藏）: ");
  const username = await requiredText("管理员账号: ");
  const displayName = await promptText("显示名（可留空）: ", { optional: true });
  const password = await promptHidden("管理员密码（隐藏）: ");
  const confirmation = await promptHidden("确认管理员密码（隐藏）: ");
  if (!bootstrapToken) throw new Error("ADMIN_BOOTSTRAP_TOKEN 未设置");
  if (password !== confirmation) throw new Error("两次输入的密码不一致");

  const endpoint = new URL("/api/auth/bootstrap", baseUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: endpoint.origin },
    body: JSON.stringify({ bootstrapToken, username, displayName: displayName || undefined, password }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : `初始化失败（HTTP ${response.status}）`);
  process.stdout.write("首位超级管理员已创建。请立即从运行环境删除 ADMIN_BOOTSTRAP_TOKEN，并重启应用后使用账号密码登录。\n");
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : "初始化失败"}\n`);
  process.exitCode = 1;
});
