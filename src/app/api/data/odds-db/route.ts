import { NextRequest, NextResponse } from "next/server";
import { getSupabaseClient } from "@/storage/database/supabase-client";
import { appendOddsSnapshots } from "@/lib/odds/snapshots";

function parseDbJsonObject(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// GET /api/data/odds-db?date=YYYYMMDD&slim=1&matchId=xxx
// slim=1: strip unused fields from companies to reduce payload size (~40% reduction)
// matchId: optional, return only this match's data (for AI analysis full data fetch)
// Returns: { success: true, data: { matchIds: string[], oddsMap: Record<string, CompanyOddsData> } }
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const date = searchParams.get("date");
    const slim = searchParams.get("slim") === "1";
    const matchId = searchParams.get("matchId");

    if (!date) {
      return NextResponse.json({ error: "Missing date parameter" }, { status: 400 });
    }

    // Fields to keep when slim=true (Data Tab display only needs these)
    const SLIM_COMPANY_FIELDS = new Set([
      "companyId", "companyName", "openTime",
      "ftHandicapHome", "ftHandicapLine", "ftHandicapAway",
      "ftHandicapHomeLive", "ftHandicapLineLive", "ftHandicapAwayLive",
      "euroAsianHome", "euroAsianLine", "euroAsianAway",
      "ftTotalOver", "ftTotalLine", "ftTotalUnder",
      "ftTotalOverLive", "ftTotalLineLive", "ftTotalUnderLive",
    ]);

    const supabase = getSupabaseClient();

    // Supabase default limit is 1000, but a single date can have 1500+ matches
    // Fetch all records using pagination, optionally filtered by matchId
    interface DbRow {
      match_id: string;
      odds_data: unknown;
      open_times_data: unknown;
      crown_live_odds: unknown;
      crown_12_odds: unknown;
      source: string | null;
      source_observed_at: string | null;
      write_token: string | null;
    }

    let allData: DbRow[] = [];
    let page = 0;
    const pageSize = 1000;
    while (true) {
      let query = supabase
        .from("match_odds")
        .select("match_id, odds_data, open_times_data, crown_live_odds, crown_12_odds, source, source_observed_at, write_token")
        .eq("match_date", date);

      if (matchId) {
        query = query.eq("match_id", matchId);
      }

      const { data, error } = await query
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (error) {
        console.error("[odds-db] Query error:", error.message);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }

      if (data && data.length > 0) {
        allData = allData.concat(data as DbRow[]);
      }

      if (!data || data.length < pageSize) break;
      page++;
    }

    const matchIds: string[] = [];
    const oddsMap: Record<string, Record<string, unknown>> = {};
    const crownLiveOddsMap: Record<string, Record<string, unknown>> = {};
    const crown12OddsMap: Record<string, Record<string, unknown>> = {};
    const oddsMetaMap: Record<string, {
      source: string | null;
      sourceObservedAt: string | null;
      writeToken: string | null;
    }> = {};

    for (const row of allData) {
      const mid = row.match_id;
      matchIds.push(mid);
      const oddsData = parseDbJsonObject(row.odds_data);
      const openTimesData = parseDbJsonObject(row.open_times_data);
      const crownLiveOdds = parseDbJsonObject(row.crown_live_odds);
      const crown12Odds = parseDbJsonObject(row.crown_12_odds);

      // Merge open times into odds data if available
      if (oddsData && openTimesData && typeof openTimesData === "object") {
        const otMap = new Map<string, string>(
          Object.entries(openTimesData).map(([k, v]) => [k, String(v)])
        );
        // Update company open times
        const companies = oddsData.companies;
        if (companies && Array.isArray(companies)) {
          for (const c of companies as Record<string, unknown>[]) {
            if (otMap.has(String(c.companyId))) {
              c.openTime = otMap.get(String(c.companyId));
            }
          }
        }
        // Update crown open time at match level
        const crownOt = otMap.get("3") || "";
        if (crownOt) {
          oddsData.openTime = crownOt;
        }
      }

      oddsMap[mid] = oddsData;
      oddsMetaMap[mid] = {
        source: row.source,
        sourceObservedAt: row.source_observed_at,
        writeToken: row.write_token,
      };
      // Strip unused company fields in slim mode
      if (slim && oddsData.companies && Array.isArray(oddsData.companies)) {
        for (const c of oddsData.companies as Record<string, unknown>[]) {
          for (const key of Object.keys(c)) {
            if (!SLIM_COMPANY_FIELDS.has(key)) {
              delete c[key];
            }
          }
        }
      }
      if (crownLiveOdds && Object.keys(crownLiveOdds).length > 0) {
        crownLiveOddsMap[mid] = crownLiveOdds;
      }
      if (crown12Odds && Object.keys(crown12Odds).length > 0) {
        crown12OddsMap[mid] = crown12Odds;
      }
    }

    return NextResponse.json({
      success: true,
      data: { matchIds, oddsMap, oddsMetaMap, crownLiveOddsMap, crown12OddsMap },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "查询失败";
    console.error("[odds-db] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function hasObjectData(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

// POST /api/data/odds-db
// Body: { matchId, matchDate, companyIds, oddsData, openTimesData? }
// Save or update odds data for a match
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      matchId,
      matchDate,
      companyIds,
      oddsData,
      openTimesData,
      crownLiveOdds,
      crown12Odds,
      source,
      sourceObservedAt,
      writeToken,
    } = body;

    if (!matchId || !matchDate || !hasObjectData(oddsData)) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    const hasFreshnessMetadata = sourceObservedAt != null || writeToken != null;
    let normalizedSourceObservedAt: string | null = null;
    let applied = true;

    if (hasFreshnessMetadata) {
      if (typeof source !== "string" || !source.trim()) {
        return NextResponse.json({ error: "source is required for timestamped writes" }, { status: 400 });
      }
      if (typeof sourceObservedAt !== "string" || !sourceObservedAt.trim()) {
        return NextResponse.json({ error: "sourceObservedAt is required for timestamped writes" }, { status: 400 });
      }
      const parsedObservedAt = new Date(sourceObservedAt);
      if (Number.isNaN(parsedObservedAt.getTime())) {
        return NextResponse.json({ error: "sourceObservedAt must be a valid timestamp" }, { status: 400 });
      }
      if (typeof writeToken !== "string" || !writeToken.trim()) {
        return NextResponse.json({ error: "writeToken is required for timestamped writes" }, { status: 400 });
      }
      normalizedSourceObservedAt = parsedObservedAt.toISOString();

      const { data: rpcRows, error: rpcError } = await supabase.rpc("upsert_match_odds_if_fresher", {
        p_match_id: String(matchId),
        p_match_date: String(matchDate),
        p_company_ids: companyIds || "3,35,42,47,8",
        p_odds_data: oddsData,
        p_open_times_data: hasObjectData(openTimesData) ? openTimesData : null,
        p_crown_live_odds: hasObjectData(crownLiveOdds) ? crownLiveOdds : null,
        p_crown_12_odds: hasObjectData(crown12Odds) ? crown12Odds : null,
        p_source: source.trim(),
        p_source_observed_at: normalizedSourceObservedAt,
        p_write_token: writeToken.trim(),
      });

      if (rpcError) {
        console.error("[odds-db] Freshness upsert error:", rpcError.message);
        return NextResponse.json({ error: rpcError.message }, { status: 500 });
      }

      const result = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows;
      applied = result?.applied === true;
      normalizedSourceObservedAt = result?.source_observed_at || normalizedSourceObservedAt;
    } else {
      return NextResponse.json({
        error: "source, sourceObservedAt and writeToken are required",
      }, { status: 400 });
    }

    if (applied) {
      await appendOddsSnapshots(supabase, {
        matchId: String(matchId),
        matchDate: String(matchDate),
        source,
        sourceObservedAt: normalizedSourceObservedAt || sourceObservedAt,
        payload: {
          oddsData,
          ...(hasObjectData(openTimesData) ? { openTimesData } : {}),
          ...(hasObjectData(crownLiveOdds) ? { crownLiveOdds } : {}),
          ...(hasObjectData(crown12Odds) ? { crown12Odds } : {}),
        },
      });
    }

    return NextResponse.json({
      success: true,
      applied,
      sourceObservedAt: normalizedSourceObservedAt,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "保存失败";
    console.error("[odds-db] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// PATCH /api/data/odds-db
// Body: { matchId, matchDate, crown12Odds?, crownLiveOdds?, openTimesData? }
// Partially update without overwriting other fields
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      matchId,
      matchDate,
      crown12Odds,
      crownLiveOdds,
      openTimesData,
      source,
      sourceObservedAt,
    } = body;

    if (!matchId || !matchDate) {
      return NextResponse.json({ error: "Missing matchId or matchDate" }, { status: 400 });
    }
    if (![crown12Odds, crownLiveOdds, openTimesData].some(hasObjectData)) {
      return NextResponse.json({ error: "No valid odds fields to update" }, { status: 400 });
    }

    const supabase = getSupabaseClient();

    const updateFields: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (hasObjectData(crown12Odds)) {
      updateFields.crown_12_odds = crown12Odds;
    }
    if (hasObjectData(crownLiveOdds)) {
      updateFields.crown_live_odds = crownLiveOdds;
    }
    if (hasObjectData(openTimesData)) {
      updateFields.open_times_data = openTimesData;
    }

    const { data: updatedRows, error } = await supabase
      .from("match_odds")
      .update(updateFields)
      .eq("match_id", matchId)
      .eq("match_date", matchDate)
      .select("match_id");

    if (error) {
      console.error("[odds-db] Patch error:", error.message);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!updatedRows || updatedRows.length === 0) {
      return NextResponse.json({ error: "Match odds record not found" }, { status: 404 });
    }

    await appendOddsSnapshots(supabase, {
      matchId: String(matchId),
      matchDate: String(matchDate),
      source,
      sourceObservedAt,
      payload: {
        ...(hasObjectData(openTimesData) ? { openTimesData } : {}),
        ...(hasObjectData(crownLiveOdds) ? { crownLiveOdds } : {}),
        ...(hasObjectData(crown12Odds) ? { crown12Odds } : {}),
      },
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "更新失败";
    console.error("[odds-db] Patch Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
