import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ADMIN_QUERY_CONTRACT_VERSION } from "./admin-query-contracts";

const payloadSchema=z.object({contractVersion:z.literal(ADMIN_QUERY_CONTRACT_VERSION),sort:z.enum(["created_desc","created_asc"]),lastCreatedAt:z.string().datetime(),lastId:z.string().uuid(),filterHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type AdminQueryCursorPayload=z.infer<typeof payloadSchema>;
export interface AdminQueryCursorCodec { encode(value:AdminQueryCursorPayload):string; decode(value:string):AdminQueryCursorPayload }
export class AdminQueryCursorError extends Error { constructor(readonly reason:"invalid"|"filter_mismatch"){super("Invalid query cursor");} }
export function adminQueryFilterHash(value:unknown){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
export function createAdminQueryCursorCodec(secret:string):AdminQueryCursorCodec {
  if(secret.length<32) throw new Error("ADMIN_QUERY_CURSOR_SECRET unavailable");
  const sign=(body:string)=>createHmac("sha256",secret).update(`strategy-lab-admin-query:v1:${body}`).digest("base64url");
  return Object.freeze({encode(value:AdminQueryCursorPayload){const body=Buffer.from(JSON.stringify(payloadSchema.parse(value))).toString("base64url");return `${body}.${sign(body)}`;},decode(value:string){try{const [body,signature,...extra]=value.split(".");if(!body||!signature||extra.length)throw new Error();const expected=Buffer.from(sign(body));const actual=Buffer.from(signature);if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error();return payloadSchema.parse(JSON.parse(Buffer.from(body,"base64url").toString("utf8")));}catch{throw new AdminQueryCursorError("invalid");}}});
}
