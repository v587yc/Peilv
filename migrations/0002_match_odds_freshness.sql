-- 0002: add source freshness metadata and atomic guarded match-odds writes.
BEGIN;

ALTER TABLE match_odds ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE match_odds ADD COLUMN IF NOT EXISTS source_observed_at TIMESTAMPTZ;
ALTER TABLE match_odds ADD COLUMN IF NOT EXISTS write_token TEXT;

CREATE OR REPLACE FUNCTION upsert_match_odds_if_fresher(
  p_match_id TEXT,
  p_match_date TEXT,
  p_company_ids TEXT,
  p_odds_data JSONB,
  p_open_times_data JSONB,
  p_crown_live_odds JSONB,
  p_crown_12_odds JSONB,
  p_source TEXT,
  p_source_observed_at TIMESTAMPTZ,
  p_write_token TEXT
) RETURNS TABLE(applied BOOLEAN, source_observed_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  written_observed_at TIMESTAMPTZ;
BEGIN
  IF NULLIF(btrim(p_source), '') IS NULL
     OR p_source_observed_at IS NULL
     OR NULLIF(btrim(p_write_token), '') IS NULL THEN
    RAISE EXCEPTION 'source, source_observed_at and write_token are required';
  END IF;

  INSERT INTO match_odds (
    match_id, match_date, company_ids, odds_data, open_times_data,
    crown_live_odds, crown_12_odds, source, source_observed_at, write_token, updated_at
  ) VALUES (
    p_match_id, p_match_date, p_company_ids, p_odds_data::TEXT, p_open_times_data::TEXT,
    p_crown_live_odds::TEXT, p_crown_12_odds::TEXT, p_source, p_source_observed_at, p_write_token, NOW()
  )
  ON CONFLICT (match_id, match_date) DO UPDATE SET
    company_ids = EXCLUDED.company_ids,
    odds_data = EXCLUDED.odds_data,
    open_times_data = COALESCE(EXCLUDED.open_times_data, match_odds.open_times_data),
    crown_live_odds = COALESCE(EXCLUDED.crown_live_odds, match_odds.crown_live_odds),
    crown_12_odds = COALESCE(EXCLUDED.crown_12_odds, match_odds.crown_12_odds),
    source = EXCLUDED.source,
    source_observed_at = EXCLUDED.source_observed_at,
    write_token = EXCLUDED.write_token,
    updated_at = NOW()
  WHERE (match_odds.source_observed_at IS NULL OR EXCLUDED.source_observed_at > match_odds.source_observed_at)
    AND match_odds.write_token IS DISTINCT FROM EXCLUDED.write_token
  RETURNING match_odds.source_observed_at INTO written_observed_at;

  IF FOUND THEN
    RETURN QUERY SELECT TRUE, written_observed_at;
  ELSE
    RETURN QUERY
      SELECT current_row.write_token = p_write_token, current_row.source_observed_at
      FROM match_odds AS current_row
      WHERE current_row.match_id = p_match_id AND current_row.match_date = p_match_date;
  END IF;
END;
$$;

INSERT INTO schema_migrations(version, description)
VALUES (
  '0002_match_odds_freshness',
  'Add source freshness metadata and reject stale or replayed timestamped match-odds writes'
)
ON CONFLICT (version) DO NOTHING;

COMMIT;
