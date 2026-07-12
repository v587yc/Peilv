import { EventEmitter } from "node:events";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("https", () => ({ default: { request: mocks.request } }));

import { fetchTitanUrl, fetchTitanUrlBuffer, TitanFetchError } from "@/lib/titan-vip-fetch";

interface FakeResponseSpec {
  status: number;
  headers?: Record<string, string>;
  body?: Buffer | string;
}

function respond(spec: FakeResponseSpec) {
  mocks.request.mockImplementationOnce((_options: unknown, callback: (response: EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
    destroy: () => void;
  }) => void) => {
    const request = new EventEmitter() as EventEmitter & { end: () => void; destroy: () => void };
    request.destroy = () => undefined;
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        headers: Record<string, string>;
        destroy: () => void;
      };
      response.statusCode = spec.status;
      response.headers = spec.headers || {};
      response.destroy = () => undefined;
      callback(response);
      const body = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body || "");
      if (body.length) response.emit("data", body);
      response.emit("end");
    };
    return request;
  });
}

beforeEach(() => {
  mocks.request.mockReset();
});

describe("Titan fetch transport", () => {
  it("returns response metadata and decompresses gzip", async () => {
    respond({ status: 200, headers: { "content-encoding": "gzip", "content-type": "text/plain" }, body: gzipSync("schedule") });
    const result = await fetchTitanUrl("https://bf.titan007.com/football/test.htm", {}, 0);
    expect(result).toMatchObject({
      requestedUrl: "https://bf.titan007.com/football/test.htm",
      finalUrl: "https://bf.titan007.com/football/test.htm",
      statusCode: 200,
      attemptCount: 1,
      redirectCount: 0,
    });
    expect(result.body.toString()).toBe("schedule");
  });

  it("keeps the buffer compatibility wrapper", async () => {
    respond({ status: 200, body: "legacy" });
    await expect(fetchTitanUrlBuffer("https://bf.titan007.com/data", {}, 0)).resolves.toEqual(Buffer.from("legacy"));
  });

  it("follows a relative redirect on an allowed Titan host", async () => {
    respond({ status: 302, headers: { location: "/football/final.htm" } });
    respond({ status: 200, body: "ok" });
    const result = await fetchTitanUrl("https://bf.titan007.com/football/start.htm", {}, 0);
    expect(result.finalUrl).toBe("https://bf.titan007.com/football/final.htm");
    expect(result.redirectCount).toBe(1);
  });

  it("rejects redirects outside Titan", async () => {
    respond({ status: 302, headers: { location: "https://example.com/challenge" } });
    await expect(fetchTitanUrl("https://bf.titan007.com/football/start.htm", {}, 0)).rejects.toMatchObject({
      code: "UPSTREAM_REDIRECT",
    });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("does not retry permanent HTTP errors", async () => {
    respond({ status: 404, body: "missing" });
    const error = await fetchTitanUrl("https://bf.titan007.com/missing", {}, 2).catch(value => value);
    expect(error).toBeInstanceOf(TitanFetchError);
    expect(error).toMatchObject({ code: "UPSTREAM_HTTP", statusCode: 404, retryable: false });
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("rejects ASCII challenge pages and oversized bodies", async () => {
    respond({ status: 200, body: "<html>Verify you are human</html>" });
    await expect(fetchTitanUrl("https://bf.titan007.com/challenge", {}, 0)).rejects.toMatchObject({ code: "UPSTREAM_BLOCKED" });

    respond({ status: 200, body: "123456" });
    await expect(fetchTitanUrl("https://bf.titan007.com/large", {}, 0, 15_000, 5)).rejects.toMatchObject({ code: "UPSTREAM_BODY_TOO_LARGE" });
  });
});
