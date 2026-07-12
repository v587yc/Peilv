import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseClient } from '@/storage/database/supabase-client';

// GET /api/league-selections?date=YYYYMMDD&mode=today|future|history
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dateKey = searchParams.get('date');
    const mode = searchParams.get('mode') || 'today';

    if (!dateKey) {
      return NextResponse.json({ success: false, error: 'Missing date parameter' }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('league_selections')
      .select('league_name')
      .eq('date_key', dateKey)
      .eq('mode', mode);

    if (error) {
      console.error('[LeagueSelections] GET error:', error);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    const leagues = (data || []).map((row: { league_name: string }) => row.league_name);
    return NextResponse.json({ success: true, leagues });
  } catch (err) {
    console.error('[LeagueSelections] GET exception:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

// POST /api/league-selections - Save league selections (replaces all for that date+mode)
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { dateKey, mode, leagues } = body as { dateKey: string; mode: string; leagues: string[] };

    if (!dateKey || !mode || !Array.isArray(leagues)) {
      return NextResponse.json({ success: false, error: 'Missing required fields: dateKey, mode, leagues' }, { status: 400 });
    }

    const supabase = getSupabaseClient();

    const nextLeagues = [...new Set(leagues.map(league => league.trim()).filter(Boolean))];

    const { data: existingRows, error: existingError } = await supabase
      .from('league_selections')
      .select('league_name')
      .eq('date_key', dateKey)
      .eq('mode', mode);

    if (existingError) {
      console.error('[LeagueSelections] SELECT error:', existingError);
      return NextResponse.json({ success: false, error: existingError.message }, { status: 500 });
    }

    const existingLeagues = new Set((existingRows || []).map((row: { league_name: string }) => row.league_name));
    const nextLeagueSet = new Set(nextLeagues);
    const leaguesToAdd = nextLeagues.filter(league => !existingLeagues.has(league));
    const leaguesToDelete = [...existingLeagues].filter(league => !nextLeagueSet.has(league));

    if (leaguesToAdd.length > 0) {
      const rows = leaguesToAdd.map((league_name: string) => ({
        date_key: dateKey,
        mode,
        league_name,
      }));

      const { error: insertError } = await supabase
        .from('league_selections')
        .insert(rows);

      if (insertError) {
        console.error('[LeagueSelections] INSERT error:', insertError);
        return NextResponse.json({ success: false, error: insertError.message }, { status: 500 });
      }
    }

    if (leaguesToDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from('league_selections')
        .delete()
        .eq('date_key', dateKey)
        .eq('mode', mode)
        .in('league_name', leaguesToDelete);

      if (deleteError) {
        console.error('[LeagueSelections] DELETE error:', deleteError);
        return NextResponse.json({ success: false, error: deleteError.message }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, count: nextLeagues.length });
  } catch (err) {
    console.error('[LeagueSelections] POST exception:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

// DELETE /api/league-selections?date=YYYYMMDD&mode=today
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const dateKey = searchParams.get('date');
    const mode = searchParams.get('mode') || 'today';

    if (!dateKey) {
      return NextResponse.json({ success: false, error: 'Missing date parameter' }, { status: 400 });
    }

    const supabase = getSupabaseClient();
    const { error } = await supabase
      .from('league_selections')
      .delete()
      .eq('date_key', dateKey)
      .eq('mode', mode);

    if (error) {
      console.error('[LeagueSelections] DELETE error:', error);
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error('[LeagueSelections] DELETE exception:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
