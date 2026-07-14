export interface NewsItem {
  title: string;
  snippet?: string | null;
}

export type NewsProvider = (query: string, limit: number) => Promise<NewsItem[] | null>;

export function createNewsSearch(provider: NewsProvider) {
  return async (homeTeam: string, awayTeam: string): Promise<string> => {
    try {
      const results = await provider(`${homeTeam} ${awayTeam} 伤停 阵容 赛前分析`, 5);
      if (!results) return "新闻搜索未配置";
      const items = results.slice(0, 5).map(item => `- ${item.title}: ${item.snippet || ""}`);
      return items.length > 0 ? items.join("\n") : "未搜到相关新闻";
    } catch {
      return "新闻搜索失败";
    }
  };
}
