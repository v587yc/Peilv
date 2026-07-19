export const DEFAULT_COMPANY_IDS = ["3", "35", "42", "47", "8"];

export const LS_PINNED_IDS_KEY = "odds_monitor_pinned_ids";
export const LS_PINNED_INFO_KEY = "odds_monitor_pinned_info";
export const LS_NOTES_KEY = "odds_monitor_notes";
export const LS_ALERT_CONFIGS_KEY = "odds_monitor_alert_configs";
export const LS_SOUND_ENABLED_KEY = "odds_monitor_sound_enabled";
export const LS_REFRESH_INTERVAL_KEY = "odds_monitor_refresh_interval";

export const DEFAULT_FOCUSED_LEAGUES = new Set([
  "英超", "英冠", "英甲", "苏超", "西甲", "西乙", "意甲", "意乙", "德甲", "德乙",
  "法甲", "法乙", "葡超", "葡甲", "荷甲", "荷乙", "比甲", "瑞典超", "瑞典甲", "挪威超",
  "挪威甲", "丹麦超", "芬兰超", "冰岛超", "爱尔兰超", "威尔士超", "波兰超", "捷甲", "罗马甲", "匈甲",
  "奥甲", "瑞士超", "希腊超", "土超", "以超", "俄超", "乌超", "日职", "日乙", "日联杯",
  "天皇杯", "韩职", "韩乙", "澳超", "美职业", "美乙", "墨超", "墨甲", "阿甲", "巴甲",
  "巴乙", "智利甲", "哥伦甲", "秘鲁甲", "中超", "亚冠", "欧冠", "欧罗巴", "欧协联", "世亚预",
  "世欧预", "世南美预", "国际赛",
]);

export const HANDICAP_MAP: Record<string, number> = {
  平手: 0,
  "0": 0,
  "平手/半球": 0.25,
  "0/0.5": 0.25,
  半球: 0.5,
  "0.5": 0.5,
  "半球/一球": 0.75,
  "0.5/1": 0.75,
  一球: 1,
  "1": 1,
  "一球/球半": 1.25,
  "1/1.5": 1.25,
  球半: 1.5,
  "1.5": 1.5,
  "球半/两球": 1.75,
  "1.5/2": 1.75,
  两球: 2,
  "2": 2,
  "两球/两球半": 2.25,
  "2/2.5": 2.25,
  两球半: 2.5,
  "2.5": 2.5,
  "两球半/三球": 2.75,
  "2.5/3": 2.75,
  三球: 3,
  "3": 3,
};
