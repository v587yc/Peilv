const PINYIN_INITIALS: Record<string, string> = {
  英: "y", 超: "c", 西: "x", 甲: "j", 意: "y", 德: "d", 法: "f", 葡: "p",
  荷: "h", 比: "b", 瑞: "r", 挪: "n", 丹: "d", 芬: "f", 冰: "b", 爱: "a",
  威: "w", 波: "b", 捷: "j", 罗: "l", 匈: "x", 奥: "a", 希: "x", 土: "t",
  以: "y", 俄: "e", 乌: "w", 日: "r", 职: "z", 乙: "y", 联: "l", 杯: "b",
  天: "t", 皇: "h", 韩: "h", 澳: "a", 美: "m", 墨: "m", 阿: "a", 巴: "b",
  智: "z", 哥: "g", 伦: "l", 秘: "m", 中: "z", 亚: "y", 冠: "g", 欧: "o",
  协: "x", 世: "s", 国: "g", 际: "j",
};

const LEAGUE_INITIALS: Record<string, string> = {
  阿: "A", 埃: "A", 爱: "A", 安: "A", 澳: "A", 巴: "B", 比: "B", 冰: "B",
  波: "B", 玻: "B", 朝: "C", 哥: "G", 丹: "D", 德: "D", 俄: "E", 芬: "F",
  法: "F", 荷: "H", 韩: "H", 黑: "H", 洪: "H", 加: "J", 捷: "J", 柬: "J",
  卡: "K", 喀: "K", 科: "K", 克: "K", 肯: "K", 拉: "L", 罗: "L", 黎: "L",
  立: "L", 卢: "L", 墨: "M", 马: "M", 缅: "M", 摩: "M", 美: "M", 挪: "N",
  南: "N", 尼: "N", 宁: "N", 欧: "O", 葡: "P", 秘: "P", 日: "R", 瑞: "S",
  塞: "S", 沙: "S", 斯: "S", 叙: "S", 土: "T", 泰: "T", 突: "T", 乌: "W",
  委: "W", 维: "W", 西: "X", 希: "X", 匈: "X", 亚: "Y", 伊: "Y", 印: "Y",
  英: "Y", 意: "Y", 越: "Y", 中: "Z", 智: "Z",
};

export function getLeagueInitial(name: string): string {
  const first = name.charAt(0);
  if (LEAGUE_INITIALS[first]) return LEAGUE_INITIALS[first];
  if (/[a-zA-Z]/.test(first)) return first.toUpperCase();
  return "#";
}

export function getLeagueCoreName(name: string, stripLevel = false): string {
  let core = name
    .replace(/U\d+$/g, "")
    .replace(/女.+$/g, "")
    .replace(/(冠|降|升|附|春|秋|杯|级|保)$/g, "")
    .replace(/(冠|降|升|附|春|秋|杯|级|保)$/g, "");

  if (stripLevel) {
    core = core.replace(/(超|甲|联|乙|丙|丁|\d+)$/g, "");
  }
  return core;
}

export function isLeagueSelected(
  leagueName: string,
  selectedLeagues: Set<string>,
): boolean {
  if (selectedLeagues.has(leagueName)) return true;

  const withLevel = getLeagueCoreName(leagueName);
  const noLevel = getLeagueCoreName(leagueName, true);
  for (const selected of selectedLeagues) {
    if (selected === "__NONE__") continue;

    const selectedWithLevel = getLeagueCoreName(selected);
    const selectedNoLevel = getLeagueCoreName(selected, true);
    if (selectedWithLevel === withLevel && selectedWithLevel.length > 0) return true;
    if (selectedNoLevel === noLevel && selectedNoLevel.length >= 1) return true;
  }
  return false;
}

export function getPinyinInitials(text: string): string {
  let result = "";
  for (const char of text) {
    if (PINYIN_INITIALS[char]) {
      result += PINYIN_INITIALS[char];
    } else if (/[a-zA-Z]/.test(char)) {
      result += char.toLowerCase();
    }
  }
  return result;
}

export function matchLeague(leagueName: string, searchText: string): boolean {
  if (!searchText) return false;

  const lower = searchText.toLowerCase().trim();
  if (!lower) return false;
  return leagueName.toLowerCase().includes(lower) || getPinyinInitials(leagueName).includes(lower);
}
