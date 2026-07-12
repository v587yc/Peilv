import { getSupabaseClient } from '@/storage/database/supabase-client';
import { NextResponse } from 'next/server';

// GET /api/user-focused-leagues - 获取用户关注联赛白名单
export async function GET() {
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from('user_focused_leagues')
      .select('league_name')
      .order('league_name');

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({
      success: true,
      leagues: (data || []).map((r: { league_name: string }) => r.league_name),
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}

// POST /api/user-focused-leagues - 替换整个白名单
export async function POST(request: Request) {
  try {
    const supabase = getSupabaseClient();
    const body = await request.json();
    const { leagues }: { leagues: string[] } = body;

    if (!Array.isArray(leagues)) {
      return NextResponse.json({ success: false, error: 'leagues must be an array' }, { status: 400 });
    }

    const nextLeagues = [...new Set(leagues.map(name => name.trim()).filter(Boolean))];

    const { data: existingRows, error: existingError } = await supabase
      .from('user_focused_leagues')
      .select('league_name');

    if (existingError) {
      return NextResponse.json({ success: false, error: existingError.message }, { status: 500 });
    }

    const existingLeagues = new Set((existingRows || []).map((row: { league_name: string }) => row.league_name));
    const nextLeagueSet = new Set(nextLeagues);
    const leaguesToAdd = nextLeagues.filter(name => !existingLeagues.has(name));
    const leaguesToDelete = [...existingLeagues].filter(name => !nextLeagueSet.has(name));

    if (leaguesToAdd.length > 0) {
      const rows = leaguesToAdd.map((name: string) => ({ league_name: name }));
      const { error: insError } = await supabase
        .from('user_focused_leagues')
        .insert(rows);

      if (insError) {
        return NextResponse.json({ success: false, error: insError.message }, { status: 500 });
      }
    }

    if (leaguesToDelete.length > 0) {
      const { error: delError } = await supabase
        .from('user_focused_leagues')
        .delete()
        .in('league_name', leaguesToDelete);

      if (delError) {
        return NextResponse.json({ success: false, error: delError.message }, { status: 500 });
      }
    }

    return NextResponse.json({ success: true, count: nextLeagues.length });
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 });
  }
}
