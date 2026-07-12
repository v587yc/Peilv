import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const { fetchTitanUrlBufferMock } = vi.hoisted(() => ({
  fetchTitanUrlBufferMock: vi.fn(),
}));

vi.mock("@/lib/titan-vip-fetch", () => ({
  fetchTitanUrlBuffer: fetchTitanUrlBufferMock,
}));

import { GET } from "@/app/api/data/match/[id]/opentimes/route";

const unavailableHtml = "<span id=\"odds2\"></span>";
const totalHtml = [
  "<span id=\"odds2\">",
  "<TR><TD>header</TD></TR>",
  "<TR><TD></TD><TD></TD><TD>0.91</TD><TD>2.5</TD><TD>0.95</TD><TD></TD><TD>即</TD></TR>",
  "</span>",
].join("");

async function request(matchId = "match-1") {
  return GET(
    new NextRequest(`http://localhost:5000/api/data/match/${matchId}/opentimes?companies=3`),
    { params: Promise.resolve({ id: matchId }) },
  );
}

afterEach(() => {
  fetchTitanUrlBufferMock.mockReset();
  vi.unstubAllGlobals();
});

describe("Crown snapshot open-times route", () => {
  it("fetches total odds even when handicap odds are unavailable", async () => {
    vi.stubGlobal("TextDecoder", class {
      decode(input: BufferSource) {
        return Buffer.from(input as ArrayBuffer).toString("utf8");
      }
    });
    fetchTitanUrlBufferMock
      .mockResolvedValueOnce(Buffer.from(unavailableHtml))
      .mockResolvedValueOnce(Buffer.from(totalHtml));

    const response = await request();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchTitanUrlBufferMock).toHaveBeenCalledTimes(2);
    expect(fetchTitanUrlBufferMock.mock.calls[1][0]).toContain("overunder.aspx");
    expect(body).toMatchObject({
      crownOpen: { handicapLine: "", totalLine: "2.5" },
      crownTerminal: { handicapLine: "", totalLine: "2.5" },
      crownStatus: { handicap: "unavailable", total: "available" },
    });
  });

  it("returns explicit unavailable status when both Crown markets have no rows", async () => {
    vi.stubGlobal("TextDecoder", class {
      decode(input: BufferSource) {
        return Buffer.from(input as ArrayBuffer).toString("utf8");
      }
    });
    fetchTitanUrlBufferMock.mockResolvedValue(Buffer.from(unavailableHtml));

    const response = await request();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.crownOpen).toBeUndefined();
    expect(body.crownStatus).toEqual({ handicap: "unavailable", total: "unavailable" });
  });

  it("fails instead of treating an unrecognized Crown page as unavailable", async () => {
    vi.stubGlobal("TextDecoder", class {
      decode(input: BufferSource) {
        return Buffer.from(input as ArrayBuffer).toString("utf8");
      }
    });
    fetchTitanUrlBufferMock.mockResolvedValue(Buffer.from("<html>unexpected response</html>"));

    const response = await request("match-bad");
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toContain("皇冠亚盘抓取失败 match-bad");
    expect(body.error).toContain("odds2 missing");
    expect(fetchTitanUrlBufferMock).toHaveBeenCalledTimes(1);
  });
});
