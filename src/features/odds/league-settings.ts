export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function readLeagues(response: Response): Promise<string[]> {
  const json = await response.json().catch(() => null) as { success?: boolean; leagues?: unknown } | null;
  return response.ok && json?.success && Array.isArray(json.leagues) ? json.leagues.filter((item): item is string => typeof item === "string") : [];
}

export async function fetchFocusedLeagues(fetcher: FetchLike, fallback: readonly string[]): Promise<string[]> {
  try {
    const leagues = await readLeagues(await fetcher("/api/user-focused-leagues"));
    return leagues.length > 0 ? leagues : [...fallback];
  } catch {
    return [...fallback];
  }
}

export async function saveFocusedLeagues(fetcher: FetchLike, leagues: ReadonlySet<string>): Promise<string[]> {
  const sorted = [...leagues].sort();
  const response = await fetcher("/api/user-focused-leagues", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ leagues: sorted }),
  });
  const json = await response.json().catch(() => null) as { success?: boolean; error?: string } | null;
  if (!response.ok || !json?.success) throw new Error(json?.error || "保存关注联赛失败");
  return sorted;
}

export async function loadLeagueSelections(fetcher: FetchLike, dateKey: string, mode: string): Promise<Set<string>> {
  if (!dateKey) return new Set();
  try {
    let leagues = await readLeagues(await fetcher(`/api/league-selections?date=${dateKey}&mode=${mode}`));
    if (leagues.length === 0) leagues = await readLeagues(await fetcher("/api/league-selections?date=DEFAULT&mode=default"));
    return new Set(leagues);
  } catch {
    return new Set();
  }
}

export function shouldFetchIncrementalLeagues(previous: ReadonlySet<string>, current: ReadonlySet<string>): Set<string> {
  return new Set([...current].filter(league => !previous.has(league) && league !== "__NONE__"));
}

export function createDebouncedLeagueSelectionSaver(fetcher: FetchLike, options: {
  delayMs?: number;
  setTimeout?: typeof globalThis.setTimeout;
  clearTimeout?: typeof globalThis.clearTimeout;
} = {}) {
  const delayMs = options.delayMs ?? 800;
  const scheduleTimeout = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimeout = options.clearTimeout ?? globalThis.clearTimeout;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    schedule(leagues: ReadonlySet<string>, dateKey: string, mode: string) {
      if (!dateKey || leagues.size === 0 || leagues.has("__NONE__")) return false;
      if (timer) cancelTimeout(timer);
      const values = [...leagues].filter(league => league !== "__NONE__");
      timer = scheduleTimeout(() => {
        timer = null;
        void fetcher("/api/league-selections", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ dateKey, mode, leagues: values }),
        }).catch(() => undefined);
      }, delayMs);
      return true;
    },
    dispose() {
      if (timer) cancelTimeout(timer);
      timer = null;
    },
  };
}
