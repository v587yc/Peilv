#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const [cwdArg, portArg, pidFileArg, stopFileArg, logFileArg] = process.argv.slice(2);
if (!cwdArg || !portArg || !pidFileArg || !stopFileArg || !logFileArg) throw new Error("launcher arguments required");
const cwd = path.resolve(cwdArg);
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5000 || port === 5001) throw new Error("unsafe E2E port");
const server = path.join(cwd, "server.js");
if (!fs.statSync(server).isFile()) throw new Error("standalone server.js missing");
const log = fs.openSync(logFileArg, "a");
const child = spawn(process.execPath, [server], {
  cwd,
  detached: false,
  env: { ...process.env, NODE_ENV: "production", HOSTNAME: "127.0.0.1", PORT: String(port), NODE_PATH: undefined },
  stdio: ["ignore", log, log],
  windowsHide: true,
});
const metadata = { pid: child.pid, cwd, port, server, launcherPid: process.pid };
fs.writeFileSync(`${pidFileArg}.tmp`, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
fs.renameSync(`${pidFileArg}.tmp`, pidFileArg);
let stopping = false;

function forceExactChild() {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync(`${process.env.SystemRoot}\\System32\\taskkill.exe`, ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  else child.kill("SIGKILL");
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (child.exitCode === null) child.kill("SIGTERM");
  setTimeout(forceExactChild, 5000).unref();
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
const watcher = setInterval(() => { if (fs.existsSync(stopFileArg)) stop(); }, 100);
child.once("exit", (code, signal) => {
  clearInterval(watcher);
  fs.closeSync(log);
  process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0));
});
