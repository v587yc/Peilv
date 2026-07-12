import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { fetchTitanUrl, TitanFetchError, type TitanFetchResponse } from "@/lib/titan-vip-fetch";
import { parseTitanLiveResults, parseTitanSchedule, type TitanScheduleResult } from "@/lib/titan-schedule";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import {
  loadPersistedFinishedResultSummary,
  persistScheduleResults,
  type PersistedResultReader,
  type PersistedResultSummary,
} from "@/lib/verification/match-results";

const BF_BASE_URL = "https://bf.titan007.com";
const LIVE_DATA_URL = "https://livestatic.titan007.com/vbsxml/bfdata_ut.js";
const REFERER = "https://live.titan007.com/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const headers: Record<string, string> = {
  Referer: REFERER,
  "User-Agent": UA,
  Accept: "*/*",
};

function isValidDate(value: string): boolean {
  if (!/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function responseMetadata(response: TitanFetchResponse, charset: string) {
  return {
    statusCode: response.statusCode,
    finalHost: new URL(response.finalUrl).hostname,
    bytes: response.body.length,
    charset,
    contentEncoding: response.headers["content-encoding"] || null,
    attemptCount: response.attemptCount,
    redirectCount: response.redirectCount,
    bodyHash: createHash("sha256").update(response.body).digest("hex"),
  };
}

function parserMetadata(result: TitanScheduleResult) {
  return {
    validation: {
      pageIdentity: result.diagnostics.pageIdentity,
      dateMatched: result.diagnostics.dateMatched,
      scheduleContainer: result.diagnostics.scheduleContainer,
      explicitEmptyMarker: result.diagnostics.explicitEmptyMarker,
    },
    parser: {
      candidateRows: result.diagnostics.candidateRows,
      parsedRows: result.diagnostics.parsedRows,
      malformedRows: result.diagnostics.malformedRows,
      malformedReasons: result.diagnostics.malformedReasons,
    },
  };
}

function logDiagnostic(date: string, mode: string, ingestion: Record<string, unknown>): void {
  console.info("[Schedule]", JSON.stringify({ date, mode, ...ingestion }));
}

async function cachedFallback(date: string): Promise<PersistedResultSummary> {
  return loadPersistedFinishedResultSummary(getSupabaseClient() as unknown as PersistedResultReader, date);
}

function failureCode(status: TitanScheduleResult["status"] | "transport"): string {
  if (status === "blocked" || status === "transport") return "SCHEDULE_UPSTREAM_FAILURE";
  if (status === "encoding_error" || status === "wrong_page") return "SCHEDULE_CONTENT_INVALID";
  return "SCHEDULE_PARSE_FAILURE";
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || "";
  const mode = searchParams.get("mode") || "";
  if (!date || !mode) {
    return NextResponse.json({ success: false, code: "INVALID_REQUEST", error: "Missing date or mode parameter" }, { status: 400 });
  }
  if (!isValidDate(date)) {
    return NextResponse.json({ success: false, code: "INVALID_REQUEST", error: "Invalid date, use YYYYMMDD" }, { status: 400 });
  }
  if (mode !== "history" && mode !== "future") {
    return NextResponse.json({ success: false, code: "INVALID_REQUEST", error: "Invalid mode" }, { status: 400 });
  }

  const prefix = mode === "history" ? "Over" : "Next";
  const url = `${BF_BASE_URL}/football/${prefix}_${date}.htm`;
  let primaryResponse: TitanFetchResponse | null = null;
  let primaryResult: TitanScheduleResult | null = null;
  let primaryTransportError: TitanFetchError | null = null;

  try {
    primaryResponse = await fetchTitanUrl(url, headers, 2, 15_000);
    primaryResult = parseTitanSchedule(primaryResponse.body, String(primaryResponse.headers["content-type"] || ""), date);
  } catch (error) {
    primaryTransportError = error instanceof TitanFetchError
      ? error
      : new TitanFetchError("UPSTREAM_TRANSPORT", error instanceof Error ? error.message : "unknown upstream failure", true);
  }

  if (primaryResponse && primaryResult && (primaryResult.status === "ok" || primaryResult.status === "valid_empty")) {
    try {
      const persistedResults = mode === "history"
        ? await persistScheduleResults(
          getSupabaseClient(),
          primaryResult.matches as unknown as Record<string, unknown>[],
          { scoreSource: "titan_schedule_history" },
        )
        : 0;
      const ingestion = {
        status: primaryResult.status,
        source: { kind: mode === "history" ? "titan_history" : "titan_future", fresh: true },
        upstream: responseMetadata(primaryResponse, primaryResult.charset),
        ...parserMetadata(primaryResult),
        persistence: { persistedResults },
      };
      logDiagnostic(date, mode, ingestion);
      return NextResponse.json({
        success: true,
        data: {
          matches: primaryResult.matches,
          leagues: primaryResult.leagues,
          matchDate: date,
          mode,
          timestamp: Date.now(),
          ingestion,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "schedule persistence failed";
      console.error("[Schedule]", JSON.stringify({ date, mode, code: "SCHEDULE_PERSISTENCE_FAILURE", message }));
      return NextResponse.json({ success: false, code: "SCHEDULE_PERSISTENCE_FAILURE", error: message }, { status: 500 });
    }
  }

  if (mode === "future") {
    const status = primaryResult?.status || "transport";
    const diagnostics = {
      status,
      code: failureCode(status),
      upstream: primaryResponse ? responseMetadata(primaryResponse, primaryResult?.charset || "unknown") : null,
      ...(primaryResult ? parserMetadata(primaryResult) : {}),
      transportCode: primaryTransportError?.code || null,
    };
    logDiagnostic(date, mode, diagnostics);
    return NextResponse.json({ success: false, code: diagnostics.code, error: "Titan schedule response was not valid", diagnostics }, { status: 502 });
  }

  let liveResponse: TitanFetchResponse | null = null;
  let liveResult: TitanScheduleResult | null = null;
  let liveTransportCode: string | null = null;
  try {
    liveResponse = await fetchTitanUrl(`${LIVE_DATA_URL}?r=007${Date.now()}`, headers, 2, 15_000);
    liveResult = parseTitanLiveResults(liveResponse.body.toString("utf8"), date);
  } catch (error) {
    liveTransportCode = error instanceof TitanFetchError ? error.code : "UPSTREAM_TRANSPORT";
  }

  if (liveResponse && liveResult?.status === "ok") {
    try {
      const persistedResults = await persistScheduleResults(
        getSupabaseClient(),
        liveResult.matches as unknown as Record<string, unknown>[],
        { scoreSource: "titan_live_bfdata", finishedOnly: true },
      );
      if (persistedResults > 0) {
        const ingestion = {
          status: "fallback_live_results",
          source: { kind: "titan_live_bfdata", fresh: true, role: "recent_results_fallback" },
          primaryFailure: {
            status: primaryResult?.status || "transport",
            transportCode: primaryTransportError?.code || null,
            upstream: primaryResponse ? responseMetadata(primaryResponse, primaryResult?.charset || "unknown") : null,
          },
          upstream: responseMetadata(liveResponse, "utf-8"),
          ...parserMetadata(liveResult),
          persistence: { persistedResults },
        };
        logDiagnostic(date, mode, ingestion);
        return NextResponse.json({
          success: true,
          data: {
            matches: liveResult.matches,
            leagues: liveResult.leagues,
            matchDate: date,
            mode,
            timestamp: Date.now(),
            ingestion,
          },
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "schedule persistence failed";
      console.error("[Schedule]", JSON.stringify({ date, mode, code: "SCHEDULE_PERSISTENCE_FAILURE", message }));
      return NextResponse.json({ success: false, code: "SCHEDULE_PERSISTENCE_FAILURE", error: message }, { status: 500 });
    }
  }

  try {
    const cached = await cachedFallback(date);
    if (cached.finishedResultCount > 0) {
      const ingestion = {
        status: "fallback_cached_results",
        source: { kind: "persisted_match_results", fresh: false, role: "cached_evidence", coverage: "unknown" },
        primaryFailure: {
          status: primaryResult?.status || "transport",
          transportCode: primaryTransportError?.code || null,
          upstream: primaryResponse ? responseMetadata(primaryResponse, primaryResult?.charset || "unknown") : null,
        },
        liveFailure: {
          status: liveResult?.status || "transport",
          transportCode: liveTransportCode,
          upstream: liveResponse ? responseMetadata(liveResponse, liveResult?.charset || "utf-8") : null,
        },
        cached,
      };
      logDiagnostic(date, mode, ingestion);
      return NextResponse.json({
        success: true,
        data: { matches: [], leagues: [], matchDate: date, mode, timestamp: Date.now(), ingestion },
      });
    }
  } catch (error) {
    console.error("[Schedule]", JSON.stringify({
      date,
      mode,
      code: "SCHEDULE_FALLBACK_QUERY_FAILURE",
      message: error instanceof Error ? error.message : "unknown fallback query failure",
    }));
  }

  const status = primaryResult?.status || "transport";
  const diagnostics = {
    status,
    code: failureCode(status),
    primary: {
      transportCode: primaryTransportError?.code || null,
      upstream: primaryResponse ? responseMetadata(primaryResponse, primaryResult?.charset || "unknown") : null,
      ...(primaryResult ? parserMetadata(primaryResult) : {}),
    },
    live: {
      status: liveResult?.status || "transport",
      transportCode: liveTransportCode,
      upstream: liveResponse ? responseMetadata(liveResponse, liveResult?.charset || "utf-8") : null,
      ...(liveResult ? parserMetadata(liveResult) : {}),
    },
  };
  logDiagnostic(date, mode, diagnostics);
  return NextResponse.json({ success: false, code: diagnostics.code, error: "Titan history results were unavailable", diagnostics }, { status: 502 });
}
