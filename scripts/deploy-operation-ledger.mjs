#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const [command, ledgerRoot, requestId, identityJson, resultPath] = process.argv.slice(2);
const request = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
if (!request.test(requestId || "")) throw new Error("Invalid request ID");
if (!path.isAbsolute(ledgerRoot || "")) throw new Error("Operation ledger root must be absolute");
const operationPath = path.join(ledgerRoot, `${requestId}.json`);
const MAX_BYTES=1024*1024;
const digest=value=>crypto.createHash("sha256").update(JSON.stringify(value),"utf8").digest("hex");
const assertRoot = () => {
  const stat=fs.lstatSync(ledgerRoot); if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform!=="win32"&&((stat.mode&0o777)!==0o700||stat.uid!==0||stat.gid!==0)))throw new Error("Unsafe operation ledger root");
};
const assertOperation = () => {
  const stat=fs.lstatSync(operationPath); if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<=0||stat.size>MAX_BYTES||(process.platform!=="win32"&&((stat.mode&0o777)!==0o600||stat.uid!==0||stat.gid!==0)))throw new Error("Unsafe operation ledger file");
};
const syncDirectory = () => { const dir=fs.openSync(ledgerRoot,"r");try{fs.fsyncSync(dir)}catch(error){if(process.platform!=="win32"||error.code!=="EPERM")throw error}finally{fs.closeSync(dir)} };
const atomicWrite = value => { const temp=`${operationPath}.next-${process.pid}`; const fd=fs.openSync(temp,"wx",0o600); try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd)}finally{fs.closeSync(fd)} fs.renameSync(temp,operationPath); syncDirectory() };
const read = () => { assertRoot(); assertOperation(); const fd=fs.openSync(operationPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let text;try{text=fs.readFileSync(fd,"utf8")}finally{fs.closeSync(fd)}const value=JSON.parse(text); if(value?.schemaVersion!==1||value.requestId!==requestId||!["running","succeeded","failed","manual-assessment"].includes(value.status)||!value.identity||typeof value.identity!=="object"||!Number.isSafeInteger(value.sequence)||value.sequence<1||!Array.isArray(value.events)||value.events.length!==value.sequence||value.eventDigest!==digest(value.events))throw new Error("Invalid operation ledger envelope"); return value; };
if (command === "check") {
  if(!fs.existsSync(ledgerRoot)){process.stdout.write("new\n");process.exit(0)}
  const identity=JSON.parse(identityJson); let existing;
  try{existing=read()}catch(error){if(error.code==="ENOENT"){process.stdout.write("new\n");process.exit(0)}throw error}
  if(JSON.stringify(existing.identity)!==JSON.stringify(identity))throw new Error("Request identity conflict");
  if(existing.status==="succeeded"){process.stdout.write("replay\n");process.exit(0)}
  throw new Error(`Request is ${existing.status}`);
} else if (command === "claim") {
  assertRoot();
  const identity=JSON.parse(identityJson); let existing;
  try{existing=read()}catch(error){if(error.code!=="ENOENT")throw error}
  if(existing){if(JSON.stringify(existing.identity)!==JSON.stringify(identity))throw new Error("Request identity conflict");if(existing.status==="succeeded"){process.stdout.write("replay\n");process.exit(0)}throw new Error(`Request is ${existing.status}`)}
  const event={sequence:1,status:"running",at:new Date().toISOString(),identityDigest:digest(identity)};const events=[event];
  const value={schemaVersion:1,requestId,status:"running",identity,claimedAt:event.at,sequence:1,events,eventDigest:digest(events),result:null};
  try { const fd=fs.openSync(operationPath,"wx",0o600); try{fs.writeFileSync(fd,`${JSON.stringify(value,null,2)}\n`);fs.fsyncSync(fd)}finally{fs.closeSync(fd)} syncDirectory(); }
  catch(error){ if(error.code!=="EEXIST")throw error; const raced=read(); if(JSON.stringify(raced.identity)!==JSON.stringify(identity))throw new Error("Request identity conflict"); throw new Error(`Request is ${raced.status}`); }
  process.stdout.write("claimed\n");
} else if (command === "finish") {
  const existing=read(); const status=identityJson; if(existing.status!=="running"||!["succeeded","failed","manual-assessment"].includes(status))throw new Error("Invalid operation transition");
  const resultStat=fs.lstatSync(resultPath);if(!resultStat.isFile()||resultStat.isSymbolicLink()||resultStat.size<=0||resultStat.size>MAX_BYTES)throw new Error("Unsafe operation result");
  const result=JSON.parse(fs.readFileSync(resultPath,"utf8"));if(result.schemaVersion!==1||result.requestId!==requestId||result.releaseId!==existing.identity.releaseId||result.status!==status)throw new Error("Operation result identity mismatch");
  const event={sequence:existing.sequence+1,status,at:new Date().toISOString(),resultDigest:digest(result),previousEventDigest:existing.eventDigest};existing.events.push(event);existing.sequence=event.sequence;existing.eventDigest=digest(existing.events);existing.status=status;existing.completedAt=event.at;existing.result=result; atomicWrite(existing);
} else if (command === "recover-running") {
  const existing=read();if(existing.status!=="running")throw new Error("Only running operations require recovery");
  const result={schemaVersion:1,status:"manual-assessment",requestId,releaseId:existing.identity.releaseId,reason:"host-restart-running-operation",completedAt:new Date().toISOString()};
  const event={sequence:existing.sequence+1,status:result.status,at:result.completedAt,resultDigest:digest(result),previousEventDigest:existing.eventDigest};existing.events.push(event);existing.sequence=event.sequence;existing.eventDigest=digest(existing.events);existing.status=result.status;existing.completedAt=event.at;existing.result=result;atomicWrite(existing);
} else if (command === "status") {
  process.stdout.write(`${JSON.stringify(read(),null,2)}\n`);
} else throw new Error("Unknown operation ledger command");
