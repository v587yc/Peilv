# 项目上下文

### 版本技术栈

- **Framework**: Next.js 16 (App Router)
- **Core**: React 19
- **Language**: TypeScript 5
- **UI 组件**: shadcn/ui (基于 Radix UI)
- **Styling**: Tailwind CSS 4
- **Database**: Supabase (PostgreSQL)
- **AI SDK**: OpenAI-compatible API (src/lib/llm.ts)

## 项目简介

实时赔率监控系统 - 监控球探网(titan007)当日足球赛事的让球盘口和大小球赔率变化。显示所有状态赛事（未开赛在上，已开赛/已完赛在底部）。

## 用户关注联赛白名单（CRITICAL，禁止修改）

历史赛程、未来赛程、预测报表**只显示、抓取、AI分析、数据校验、AI验证、AI深入学习**白名单联赛的赛事。今日赛程保留全部联赛（实时监控需要）。

### 实现方式（CRITICAL）

- **存储**：`user_focused_leagues` 数据库表（league_name UNIQUE）
- **API**：`GET/POST /api/user-focused-leagues` — 获取/替换白名单
- **前端**：`userFocusedLeagues` state（从DB动态加载），取代旧的硬编码常量
- **兜底**：`DEFAULT_FOCUSED_LEAGUES` 常量（63个核心联赛），API加载失败时使用
- **管理UI**：数据Tab信息栏"白名单(N)"按钮 → 弹窗勾选/搜索/手动添加/删除 → 保存后自动同步

### 全局生效范围

| 功能 | 今日赛程 | 历史/未来赛程 | 预测报表 |
|------|---------|-------------|---------|
| 赛事显示 | 全部联赛 | 仅白名单 | 仅白名单（前端filteredReportData过滤） |
| 赔率抓取 | 全部 | 仅白名单 | - |
| AI分析 | 全部 | 仅白名单 | - |
| 批量AI分析 | 全部 | 仅白名单 | - |
| 数据校验 | 全部 | 仅白名单 | - |
| AI验证 | 全部 | 仅白名单 | 仅白名单 |
| AI深入学习 | 全部 | 仅白名单 | 仅白名单 |

### 规则（CRITICAL，禁止违反）
1. **今日赛程**：显示全部联赛，不限制（实时监控需要）
2. **历史赛程**：只显示/抓取/AI分析/数据校验白名单联赛
3. **未来赛程**：只显示/抓取/AI分析白名单联赛
4. **预测报表**：前端 `filteredReportData` 按白名单过滤rows并重算summary统计
5. **自动抓取**：历史/未来模式下只抓取白名单联赛的赔率
6. **批量AI分析**：历史/未来模式下只分析白名单联赛的赛事
7. **单场AI按钮**：非白名单联赛不显示AI按钮（因为赛事本身已被过滤掉）
8. **AI验证+学习**：仅白名单联赛的赛事参与验证和学习
9. **禁止**在历史/未来模式下添加白名单以外的联赛到dataTabMatches
10. **保存自动同步**：白名单保存后，历史赛程dataTabMatches自动重新过滤（state变化触发useMemo重算），预测报表自动重新加载
11. **初始数据**：DB已预置281个联赛（来源：历史prediction_results + 63个核心联赛），用户可通过UI增删
12. **如需新增联赛**：通过UI添加后保存即生效，无需改代码；同时需更新本白名单文档
13. **部署时必须勾选** `user_focused_leagues` 表

## 目录结构

```
├── public/                 # 静态资源
├── scripts/                # 构建与启动脚本
├── src/
│   ├── app/
│   │   ├── api/odds/       # 后端 API - 代理抓取赔率数据
│   │   │   └── route.ts    # GET /api/odds - 返回所有状态赛事+赔率数据
│   │   ├── api/schedule/   # 历史赛程 API
│   │   │   └── route.ts    # GET /api/schedule?date=YYYYMMDD&mode=history|future
│   │   ├── api/data/matches/ # 批量赔率抓取 API
│   │   │   └── route.ts    # GET /api/data/matches - 批量抓取多场赛事赔率
│   │   ├── api/data/match/[id]/ # 单场赔率抓取 API
│   │   │   └── route.ts    # GET /api/data/match/{id} - 单场赛事赔率抓取(快速,~0.2s)
│   │   ├── api/data/match/[id]/opentimes/ # 开盘时间+皇冠新数据API
│   │   │   └── route.ts    # GET /api/data/match/{id}/opentimes?companies=3,35,42,47 - 合并抓取
│   │   ├── api/data/match/[id]/crown-live/ # 皇冠新数据API(独立)
│   │   │   └── route.ts    # GET /api/data/match/{id}/crown-live - changeDetail皇冠开盘赔率
│   │   ├── api/data/odds-db/ # 赔率数据库API
│   │   │   └── route.ts    # GET/POST/PATCH /api/data/odds-db - 查询/保存赔率到Supabase
│   │   ├── api/prediction/ # 预测数据 API - 按日期CRUD（已改用数据库，不再依赖S3）
│   │   │   └── route.ts    # GET/POST/DELETE /api/prediction
│   │   ├── api/report/     # 报表 API - 生成/查询预测报表（已改用数据库，不再依赖S3）
│   │   │   └── route.ts    # GET/POST /api/report
│   │   ├── api/fetch-url/  # URL抓取 API - 从链接提取JSON
│   │   │   └── route.ts    # POST /api/fetch-url - 抓取URL内容并提取JSON
│   │   ├── api/league-selections/ # 联赛筛选持久化 API
│   │   │   └── route.ts    # GET/POST/DELETE /api/league-selections - 按日期+模式CRUD
│   │   ├── api/user-focused-leagues/ # 用户关注联赛白名单 API
│   │   │   └── route.ts    # GET/POST /api/user-focused-leagues - 获取/替换白名单(全局)
│   │   ├── api/analysis/   # AI分析 API - 赔率走势预测
│   │   │   └── route.ts    # POST /api/analysis - 规则引擎6指标+Web搜索新闻+LLM综合决策
│   │   ├── api/analysis/chat/ # AI对话 API
│   │   │   └── route.ts    # POST /api/analysis/chat - SSE流式对话
│   │   ├── api/analysis/learn/ # AI学习 API
│   │   │   └── route.ts    # GET/POST /api/analysis/learn - 挖掘模式+动态权重
│   │   ├── api/analysis/verify/ # AI验证 API
│   │   │   └── route.ts    # GET /api/analysis/verify - 验证历史预测准确率
│   │   ├── api/feishu/     # 飞书机器人通知 API
│   │   │   ├── _helpers.ts # 飞书通知辅助函数(发消息/AI分析/定时任务/验证学习/赔率提醒)
│   │   │   └── notify/route.ts # POST/GET /api/feishu/notify - 发送飞书消息/检查配置
│   │   ├── api/settings/   # 应用设置 API
│   │   │   └── route.ts    # GET/POST /api/settings - 应用设置(飞书Webhook等)
│   │   ├── odds/           # 赔率监控页面
│   │   │   ├── layout.tsx
│   │   │   └── page.tsx    # 主页面（客户端渲染）
│   │   ├── layout.tsx      # 根布局
│   │   ├── page.tsx        # 首页（重定向到 /odds）
│   │   └── globals.css     # 全局样式
│   ├── components/ui/      # Shadcn UI 组件库
│   ├── storage/database/   # Supabase 数据库
│   │   ├── shared/schema.ts    # 数据库schema
│   │   └── supabase-client.ts  # Supabase客户端(service_role_key绕过RLS)
│   └── lib/utils.ts        # 工具函数
├── package.json
└── tsconfig.json
```

## 核心功能

1. **数据源**: 通过后端 API 代理从 `livestatic.titan007.com` 抓取赛事数据和赔率数据
   - `bfdata_ut.js` - 赛事基础数据（联赛、队伍、时间等）
   - `goalBf3.xml` - 亚盘赔率数据（让球、大小球、水位）— 仅用于赔率监控Tab即时数据
   - `/analysis/odds/{matchId}.htm` - 完整公司赔率数据（含欧转亚盘，直接从原网站抓取，非自行转换）
2. **赛事状态分组**: 未开赛赛事在上，已开赛/已完赛赛事在底部（分隔线区分）
3. **联赛筛选**: 支持多选/全选联赛（拼音首字母分组）
4. **置顶功能**: 支持单场赛事置顶显示
5. **赔率提醒**: 对指定赛事设置让球/大小球/赔率升降阈值，超限触发弹窗+声音提醒
6. **实时刷新**: 可配置 3-120 秒自动刷新间隔
7. **赔率变化标识**: 红色=上升，绿色=下降
8. **预测数据**: 支持从链接抓取(Coze分享链接等)或粘贴JSON，按日期存储到Supabase prediction_data表，多人共享
9. **赔率对比**: 预测赔率与实时赔率对比，diff = 笔记选中方赔率 + 即时对方赔率 - 基准总赔率(默认1.88，可自行输入)。已补(已结算)的笔记不再进入赔率对比计算
10. **预测报表**: 每日生成预测准确率报表，受让降盘/让球升盘=正确(-)
11. **URL抓取**: 后端使用原生fetch抓取URL内容并自动提取JSON
12. **数据Tab手动抓取**: 赛事筛选后默认只显示基本信息，每场旁有"抓取赔率"按钮
13. **批量抓取**: 信息栏"批量抓取"按钮一次抓取所有可见未开赛赛事赔率（不受数量限制），含进度显示
14. **补充抓取**: 信息栏"补充抓取"下拉菜单，可选补充缺失赔率/缺失开盘时间/缺失新数据/缺失终盘，只抓取缺失项。含"刷新检测"按钮实时更新缺失数量
15. **中止抓取**: 抓取进行中显示"中止抓取"按钮，点击立即停止
16. **欧转亚盘**: 从原网站/analysis/odds/端点直接抓取，非自行计算转换
17. **开盘时间+皇冠新数据**: 从changeDetail端点合并抓取（同一API返回开盘时间和皇冠新数据），一次请求获取全部
18. **公司排序**: 按开盘时间从早到晚排序，无开盘时间的排末尾。开盘时间格式为"M-D HH:MM"（如"4-6 17:19"），字符串直接比较会导致"4-6">"4-16"的错误排序，必须使用`normalizeOpenTime()`补零后再比较（"04-06"<"04-16"）
19. **自动抓取**: 页面加载时自动抓取赛事赔率。有赛事筛选时按筛选抓取，无筛选时按热门赛事抓取
20. **定时任务**: 北京时间每日12:02自动抓取今日赛程中没有数据的赛事（已抓取的跳过），每天仅执行一次
21. **皇冠新数据**: 从changeDetail页面抓取皇冠开盘赔率(handicap+overunder"即"状态最后一行全场数据)，保存到crown_12_odds字段。客队下方直接显示（无标签）。与开盘时间合并抓取（同一API返回）。显示规则：今日赛程=北京时间12:10后由定时任务抓取；历史赛程=fetchSingleMatchOdds后异步抓取；未来赛程=暂不显示和抓取
22. **历史赛程增强**: 日期范围选择、全场比分+半场比分、皇冠终盘(主队下方)+新数据(客队下方)、Excel导出
23. **赔率数据库持久化**: 所有抓取的赔率数据自动保存到Supabase match_odds表，已保存赛事不重复抓取。含crown_live_odds字段保存终盘赔率快照(优先用/analysis/odds/皇冠liveOdds)，crown_12_odds字段保存皇冠新数据(从changeDetail抓取)
24. **增量自动抓取**: 用户手动新增联赛时，自动抓取新增联赛中未保存的赛事赔率
25. **全公司抓取+选择性显示**: 抓取时获取所有公司赔率数据，默认只显示4家公司(皇冠/盈禾/18博/平博)，用户可在展开区域点击添加其他公司
26. **AI水位方向预测**: 混合模型（规则引擎6指标+Web Search新闻+LLM决策），预测哪边水位下降（主降水/客降水）。水位下降=该方被市场看好=资金流入。信息栏+赔率监控Tab"AI分析"下拉菜单（分析首场/批量AI分析/验证+学习）和每场赛事旁"AI"按钮触发分析
27. **AI对话沟通**: 分析结果下方"对话"按钮，展开聊天面板与LLM实时沟通（流式SSE输出），可补充信息、质疑分析、追问细节
28. **机器学习进化**: 预测结果自动存入prediction_results表，赛后对比验证(verify API)，挖掘高命中率模式(learn API)，动态调整指标权重，经验注入下次LLM分析
29. **批量AI分析**: 信息栏+赔率监控Tab下拉菜单"批量AI分析"按钮，自动串行分析所有可见未开赛赛事，每场1.2秒间隔防限流，实时进度显示(如"3/15")，支持中止
30. **新数据vs即时数据差值**: 赔率监控Tab中，仅AI推荐方向一方显示差值。推荐=主→主队名左侧显示升降盘标识+水位差；推荐=客→客队名右侧显示升降盘标识+水位差。无AI推荐不显示。正值红色(升)，负值绿色(降)
31. **自动AI分析**: 北京时间12:15自动触发全量AI分析（在12:02赔率抓取+12:10皇冠新数据抓取完成后），分析所有已抓取赔率的未开赛赛事，每天仅执行一次
32. **预测结果持久化**: AI分析结果存入prediction_results表，页面加载时从DB读取已有预测填充analysisResults，避免重复分析导致结果不稳定。手动点击"AI"按钮可强制重新分析(forceReanalyze=true)
33. **AI分析数据源区分**: 今日赛程只分析公司初盘赔率+皇冠新数据(稳定不变)；未来赛程分析公司初盘赔率+皇冠即时数据；历史赛程只做验证不做新分析(历史模式禁用AI分析按钮)。不使用实时变动的即时赔率，确保预测方向稳定不因赔率波动而翻转

## 每日定时任务时间表（北京时间）

| 时间 | 任务 | 说明 |
|------|------|------|
| 12:02 | 自动抓取赔率 | 抓取今日赛程中没有数据的赛事（已抓取跳过） |
| 12:10 | 自动抓取皇冠新数据 | 抓取crown_12_odds（changeDetail开盘赔率） |
| 12:15 | 自动AI分析 | 全量分析所有已抓取赔率的未开赛赛事 |
| 02:00 | 自动验证+学习 | 验证昨日预测准确率 → 挖掘模式 → 调整权重 |

每个任务每天仅执行一次（`autoFetchDoneRef`/`autoAIDoneRef`/`autoVerifyDoneRef` 按日期去重）。

## ⚠️ 公司映射（已确认正确，禁止修改）

### 网站返回的缩写格式
网站`/analysis/odds/`端点返回的公司名是**缩写+星号**格式，如 `Crow*`、`盈*`、`18*`。
后端通过 `resolveCompanyName()` 函数将缩写映射为全名（去掉星号，匹配前缀）。

### companyId → 缩写 → 全名 对照表（已验证，不可修改）

| companyId | 网站缩写 | 全名 |
|-----------|---------|------|
| **3** | **Crow*** | **皇冠** |
| **35** | **盈*** | **盈禾** |
| **42** | **18*** | **18博** |
| **47** | **平*** | **平博** |
| 1 | 澳* | 澳门 |
| 8 | 36* | 36bet |
| 12 | 易* | 易胜博 |
| 14 | 伟* | 伟德 |
| 17 | 明* | 明升 |
| 24 | 12* | 12BET |
| 31 | 利* | 利记 |
| 50 | 1x* | 1xbet |

**默认4家公司**: `3,35,42,47`（皇冠、盈禾、18博、平博）

### 重要提醒
- companyId=1 是**澳门**，不是皇冠！
- companyId=3 是**皇冠(Crow*)**，不是盈禾！
- 公司映射使用 `resolveCompanyName(缩写名)` 动态解析，**不要用硬编码的companyId→名称映射**

## 数据抓取规范（已验证，禁止修改）

### 1. 赔率数据 `/analysis/odds/{matchId}.htm`
- **返回格式**: HTML，包含 `<input type='hidden' value='DATA'>`
- **allCompOdds格式**: `companyId;companyName;initOdds;liveOdds;runOdds;flags^companyId;...`
- **每个赔率字符串14个逗号分隔字段**:
  - `[0-2]` = 欧赔 (home, draw, away)
  - `[3-5]` = **欧转亚盘** (home, line, away) ← 原网站数据，非自行转换
  - `[6]` = 跳过
  - `[7-9]` = 实际亚盘 (home, line, away)
  - `[10]` = 跳过
  - `[11-13]` = 进球数 (over, line, under)
- **盘口值格式**: 中文如 "半/一"、"两/两球半"、"两球半/三"、数字如"0.5"、"1"、"2.5"
- **响应速度**: ~0.2秒（不含开盘时间）

### 2. 开盘时间 + 皇冠新数据（合并API）
- **API端点**: `GET /api/data/match/{id}/opentimes?companies=3,35,42,47`
- **一次请求返回**: 开盘时间（所有公司） + 皇冠新数据（companyid=3的开盘赔率）
- **开盘时间**: `vip.titan007.com/changeDetail/handicap.aspx`
- **皇冠新数据**: 同一页面解析（companyid=3时额外提取"即"状态最后一行全场数据）
- **overunder**: 额外抓取 `changeDetail/overunder.aspx?companyid=3` 获取进球数新数据
- **编码**: GBK，需用 `TextDecoder("gbk")` 解码
- **开盘时间格式**: 如 "4-20 00:57"，正则 `(\d{1,2}-\d{1,2}\s+\d{1,2}:\d{2})`
- **开盘时间取值规则**: 最后一个匹配=最早(开盘)时间（行按最新→最旧排列）
- **抓取策略**: **串行**（非并发），3次重试，15秒超时，避免并发导致超时
- **响应速度**: 4家公司串行+overunder约15-20秒
- **返回格式**: `{ success: true, data: [{companyId, openTime}], crownOpen: {handicapHome, handicapLine, handicapAway, totalOver, totalLine, totalUnder} }`

### 3. 前端加载架构（合并抓取）
- 赔率数据**快速返回**（0.2秒），前端立即显示
- 开盘时间+皇冠新数据**一次异步抓取**（~15-20秒），返回后自动更新state刷新显示
- 不允许因开盘时间/新数据慢而阻塞赔率数据显示
- 12:10定时器使用合并API（companies=3，只抓皇冠新数据）

### 4. 数据Tab表格布局
`开盘时间 | 联赛 | 时间 | 比分(历史) | 半场(历史) | 主队 | 客队 | 公司 | 亚盘(初) | 欧转亚盘(初) | 进球数(初)`

- 开盘时间：每行显示对应公司的开盘时间（非合并）
- 皇冠作为公司行显示初盘数据（与盈禾、18博、平博同级）
- **主队列内皇冠赔率**：
  - **今日模式(state=0)**：主队名称下方显示goalBf3.xml即时赔率
    - 上行：亚盘（主水 盘口 客水），盘口居中加粗，可点击跳转皇冠详情页
    - 下行：进球数（大水 盘口 小水），盘口居中加粗
    - 无即时数据时不显示
  - **今日模式(state!=0)**：主队名称下方显示终盘（crown_live_odds，带"终盘"标签，灰色）
  - **历史模式**：主队名称下方显示终盘（所有比赛已完场）
  - **未来模式**：主队名称下方显示goalBf3.xml即时赔率（与今日state=0相同）
- **客队列内皇冠新数据**：
  - 客队名称下方显示DB中crown_12_odds（无标签）
  - 数据来源: changeDetail handicap+overunder页面"即"状态最后一行全场数据（即"即"→"早"分界处的开盘赔率）
  - **显示规则**：今日赛程（北京时间12:10后由定时任务填充）+ 历史赛程（fetchSingleMatchOdds后异步抓取）；未来赛程暂不显示
  - 无数据时不显示
- 比分列和半场列仅在历史模式下显示

### 5. 赔率监控Tab表格布局
`展开 | 置顶 | 提醒 | 笔记 | 联赛 | 时间 | 主队 | 亚盘(3td) | 客队 | 进球数(3td)`

- **亚盘列**：3个独立td — `主水(右对齐) | 盘口(居中加粗) | 客水(左对齐)`，盘口可点击跳转皇冠详情页
- **进球数列**：3个独立td — `大水(右对齐) | 盘口(居中加粗) | 小水(左对齐)`
- **禁止使用单个td+inline-flex+固定宽度**：会导致列错位（盘口值长时溢出，后续列被挤压）
- **只显示未开赛赛事**：`filteredMatches` 必须过滤 `m.state === "0"`
- **展开功能**：点击展开按钮，自动抓取并显示公司赔率数据（使用dbCompanyOddsMap）
  - 展开时若无数据，自动调用fetchSingleMatchOdds抓取
  - 显示开盘时间、公司、亚盘(初)、欧转亚盘(初)、进球数(初)
  - **不包含**皇冠即时数据（即时数据已在主行显示）
  - 默认显示4家公司，可展开更多公司

## 赛事数据结构

- `A[i][0]` = 赛事ID, `A[i][2]` = 联赛名, `A[i][5]` = 主队, `A[i][8]` = 客队
- `A[i][11]` = 开赛时间, `A[i][13]` = 赛事状态(0=未开赛)
- `A[i][22]` = 主队排名(格式如"土超7"，需提取末尾数字), `A[i][23]` = 客队排名(同上)
- `A[i][45]` = 联赛ID(sclassId)
- `A[i][62]` = 热门赛事标识("1"=热门)
- 赔率XML `<m>` 节点: matchId,oddsId,让球,主水,客水,...,大小球,大水,小水,...

## 包管理规范

**仅允许使用 pnpm** 作为包管理器

## 开发规范

### Hydration 问题防范
- 使用 'use client' + useEffect + useState 确保动态内容仅在客户端渲染
- 严禁在 JSX 渲染逻辑中直接使用 typeof window、Date.now()、Math.random()

## UI 组件规范
- 使用 shadcn/ui 组件库
- 暗色主题为主（`bg-[#0a0e17]` 深色背景）

## 热门赛事筛选逻辑（已验证，禁止修改）

### 数据源
- `B[j][10]` != "0" = 重要/热门联赛（来自 bfdata_ut.js 的 B 数组）
- `A[i][62]` == "1" = 热门赛事（精简赛程标识）
- **热门赛事计数基于所有状态的赛事（包含已开赛），不仅仅是未开赛**
- 筛选逻辑与原始网站 `SelectImportant()` 函数完全一致

### 实现方式
- API (`/api/odds`) 解析 B 数组提取 `hotLeagueIds`，标记每个联赛的 `isHot` 字段
- API 解析 `A[i][62]` 标记每场赛事的 `isHot` 字段
- API 遍历所有A数组条目（不受state过滤）统计 `hotMatchCount`，返回给前端
- 前端使用 `totalHotMatchCount` 显示热门赛事数（今日=API hotMatchCount，历史/未来=从schedule数据计算）
- 前端 `hotLeagues` 直接使用 `dataTabLeagues.filter(l => l.isHot)` 筛选
- **禁止**使用硬编码的 majorLeagueIds 集合替代网站原始标识
- **禁止**仅用 state==0 的赛事数作为热门赛事计数

## 历史/未来赛程数据源（已验证，禁止修改）

### 数据源 URL
- **历史（完赛）**: `https://bf.titan007.com/football/Over_YYYYMMDD.htm`
- **未来（未赛）**: `https://bf.titan007.com/football/Next_YYYYMMDD.htm`
- **编码**: GBK，需用 `TextDecoder("gbk")` 解码

### HTML 解析规则
- 比赛 `<tr>` 标签含 `name='SCLASSID,ORDER'` 和 `sId='MATCHID'` 属性（name 在 sId 前面）
- `<td>` 结构:
  - `td[0]` = 联赛名（含 bgcolor 属性）
  - `td[1]` = 时间（如 "22日11:00"）
  - `td[2]` = 状态（"完"=已完赛, ""=未开赛, "中"=进行中）
  - `td[3]` = 主队（可能含 [春14] 等排名信息）
  - `td[4]` = 比分
  - `td[5]` = 客队
  - `td[6]` = 半场比分
  - `td[7]` = 让球盘口（含 val 属性）
  - `td[8]` = 大小球盘口（含 val 属性）

### 前端加载架构
- `dataScheduleMode` 切换时，通过 `/api/schedule` API 获取对应日期数据
- 今日模式：使用 `/api/odds` 的 `matches` 和 `leagues`
- 历史/未来模式：使用 `scheduleMatches` 和 `scheduleLeagues`
- `dataTabMatches` 和 `dataTabLeagues` 根据 mode 自动选择数据源
- 赔率抓取功能对所有模式通用（/api/data/match/{id} 不依赖赛事来源）

### 热门联赛在历史/未来赛程中的处理
- 历史/未来页面 HTML 内嵌 `importantSclass` 变量，包含该日期的热门联赛ID列表
- 格式：`importantSclass = ",36,31,11,60,...,";`（逗号分隔，首尾有逗号）
- `/api/schedule` 从 HTML 解析 `importantSclass`，用 `,ID,` 包含匹配标记联赛和赛事的 `isHot`
- **禁止**用今日数据的 hotLeagueIds 标记历史/未来赛程的热门联赛（不同日期的热门联赛列表不同）
- **禁止**在 schedule API 中硬编码热门联赛ID

## 数据库（Supabase）

### 表清单与RLS策略

| 表名 | 用途 | RLS | 策略 |
|------|------|-----|------|
| `match_odds` | 赔率数据持久化 | ✅ 已启用 | Allow all (SELECT/INSERT/UPDATE/DELETE) |
| `prediction_data` | 预测数据(按日期JSON) | ✅ 已启用 | Allow all |
| `prediction_results` | AI预测结果+验证 | ✅ 已启用 | Allow all |
| `learned_patterns` | 机器学习模式+权重 | ✅ 已启用 | Allow all |
| `daily_reports` | 每日预测报表 | ✅ 已启用 | SELECT+INSERT+UPDATE+DELETE (4条策略) |
| `league_selections` | 联赛筛选持久化 | ✅ 已启用 | Allow all |
| `user_focused_leagues` | 用户关注联赛白名单 | ✅ 已启用 | Allow all |
| `app_settings` | 应用设置(飞书Webhook等) | ✅ 已启用 | Allow all |
| `health_check` | 健康检查 | ❌ 未启用 | 无 |

**重要**:
- 所有业务表都有RLS Allow all策略，允许匿名读写
- API使用service_role_key绕过RLS，多人同时使用都能正常读写
- 如果重建表，**必须重新添加RLS策略**，否则所有写入操作会静默失败

### league_selections 表结构
```sql
CREATE TABLE league_selections (
  id SERIAL PRIMARY KEY,
  date_key VARCHAR(20) NOT NULL,       -- 日期 YYYYMMDD
  mode VARCHAR(10) NOT NULL DEFAULT 'today',  -- today/future/history
  league_name TEXT NOT NULL,            -- 联赛名
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(date_key, mode, league_name)
);
```
- 按日期+模式存储用户选择的联赛，页面加载时自动恢复
- 切换模式/日期时从DB加载联赛选择，修改时自动保存（800ms防抖）
- 自动抓取只抓取已选联赛的赛事（无选择时抓取热门赛事）

### match_odds 表结构
```sql
CREATE TABLE match_odds (
  id SERIAL PRIMARY KEY,
  match_id VARCHAR(20) NOT NULL,        -- 赛事ID
  match_date VARCHAR(10) NOT NULL,      -- 日期 YYYYMMDD格式
  company_ids TEXT NOT NULL DEFAULT '3,35,42,47',
  odds_data JSONB NOT NULL,             -- CompanyOddsData JSON
  open_times_data JSONB DEFAULT '{}',   -- 开盘时间JSON
  crown_live_odds JSONB DEFAULT '{}',   -- 皇冠终盘赔率快照(开赛前最后一刻)
  crown_12_odds JSONB DEFAULT '{}',     -- 皇冠新数据(从changeDetail抓取的开盘赔率)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(match_id, match_date)          -- 同一赛事同一天只存一条
);
```

### league-selections API端点
- **GET** `/api/league-selections?date=YYYYMMDD&mode=today|future|history` - 获取联赛选择
  - 返回: `{ success: true, leagues: ["英超", "西甲", ...] }`
- **POST** `/api/league-selections` - 保存联赛选择（替换该日期+模式的所有选择）
  - Body: `{ dateKey: "20260423", mode: "today", leagues: ["英超", "西甲"] }`
  - 先删除旧数据再插入新数据
- **DELETE** `/api/league-selections?date=YYYYMMDD&mode=today` - 删除某日期+模式的联赛选择

### odds-db API端点
- **GET** `/api/data/odds-db?date=YYYYMMDD` - 查询某日已保存赔率
  - `?slim=1` 参数：只返回12个展示字段（减48%传输量），前端展示用
  - `?matchId=xxx` 参数：只获取单场完整（非slim）数据，**AI分析时必须用此参数**获取完整字段(openTime/liveOdds/euroOdds等)
  - 返回: `{ success: true, data: { matchIds, oddsMap, crownLiveOddsMap, crown12OddsMap } }`
  - 开盘时间会自动合并到oddsData的companies中
  - 支持分页加载（Supabase默认1000条限制，单日可能超过1476条）
- **POST** `/api/data/odds-db` - 保存/更新赛事赔率
  - Body: `{ matchId, matchDate, companyIds, oddsData, openTimesData?, crownLiveOdds?, crown12Odds? }`
  - 使用upsert（match_id+match_date唯一约束）
  - crownLiveOdds/crown12Odds仅当有实际数据时才包含在upsert中，避免空对象覆盖已有数据
- **PATCH** `/api/data/odds-db` - 部分更新(不覆盖其他字段)
  - Body: `{ matchId, matchDate, crown12Odds? }`
  - 用于只更新crown_12_odds而不覆盖整个记录

### prediction_data 表结构
```sql
CREATE TABLE prediction_data (
  id SERIAL PRIMARY KEY,
  date_key VARCHAR(20) NOT NULL UNIQUE,  -- 日期 YYYYMMDD
  json_content TEXT,                       -- 预测JSON
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```
- 原S3对象存储已移除，预测数据全部改用此表存储

### prediction_results 表
- match_id + match_date 唯一约束
- 6项指标信号值(indicator_handicap_direction等，信号值为主降水/客降水/中立)
- 加权分数(up_score, down_score)
- **水位方向字段（核心）**: water_direction(预测水位方向), actual_water_direction(实际水位方向)
- 验证字段(actual_handicap_trend, actual_water_direction, is_correct, verified_at) — is_correct由02:00自动验证写入（基于水位方向）
- 手动验证字段(manual_is_correct) — 由赔率监控页面✓/✗按钮写入，与is_correct独立，互不干扰

### learned_patterns 表
- pattern_key + league 唯一约束
- 统计: total_predictions, correct_predictions, hit_rate
- 动态权重: suggested_weights (JSONB)
- 注入到分析时的LLM prompt中

## AI水位方向预测系统

### 核心预测目标（CRITICAL，禁止修改）

**预测哪边水位下降**，而非盘口升降方向。
- 主降水 = 主队水位下降 = 资金流入主队 = 市场看好主队
- 客降水 = 客队水位下降 = 资金流入客队 = 市场看好客队
- 不变 = 水位无明显方向变化

**为什么预测水位方向而非盘口升降**：
- 63.7%的赛事盘口不变（handicap_trend="不变"），预测盘口升降方向几乎无意义
- 水位变化比盘口变化更频繁、更敏感，是庄家真实态度的反映
- 水位方向直接对应"哪边被市场看好"，实用性更强

### 双模式验证规则（CRITICAL，禁止修改）

**核心原则**：验证水位方向预测时，根据盘口是否变化选择不同验证方式。

**方式1 - 盘口一致**（crown12盘口=crown_live盘口，绝对值差<0.25）：
- 用水位变化方向验证：crown12主水→crown_live主水
- 主水下降 → 主降水，客水下降 → 客降水
- 水位容差：水位差≤0.03时视为正确（盘口不变+水位微调=方向不明=正确）
- 更精确地反映市场在盘口不变时的真实态度

**方式2 - 盘口不一致**（crown12盘口≠crown_live盘口）：
- 用升降盘规则验证（新数据盘口→终盘盘口绝对值比较）
- **升盘 = 让球方优势扩大 → 让球方水位应下降**：
  - 主让盘升盘 → 主降水正确，客降水错误
  - 客让盘升盘 → 客降水正确，主降水错误
- **降盘 = 让球方优势缩小 → 受让方水位应下降**：
  - 主让盘降盘 → 客降水正确，主降水错误
  - 客让盘降盘 → 主降水正确，客降水错误
- **让球方识别**: crown12.handicapLine > 0 → 主让球，< 0 → 客让球
- **验证基准**: crown12(新数据)→crown_live(终盘)，不是初盘→终盘

**案例**：
- 埃及超降 泽德FC(中)vs佩哈亚克：半球→平手/半球，主让球降盘(0.5→0.25)，降盘→客降水正确
- 英超 阿森纳vs切尔西：受0.5→受0.25，客让球降盘(|0.5|>|0.25|)，降盘→主降水正确

### AI分析数据源区分（CRITICAL）

| 赛程模式 | 初盘数据 | 参照数据 | AI分析 | 说明 |
|---------|---------|---------|--------|------|
| 今日 | 公司初盘赔率 | 皇冠新数据(crown12) | ✅ 可分析 | 基于稳定开盘赔率 |
| 未来 | 公司初盘赔率 | 皇冠即时数据(crownLive) | ✅ 可分析 | 未来赛程尚无crown12 |
| 历史 | - | - | ❌ 禁用 | 历史模式只做验证，AI按钮禁用 |

**核心原则**: 不使用实时变动的即时赔率，确保预测方向稳定不因赔率波动而翻转。

### 分析请求Body（当前版本，已移除即时赔率字段）
```json
{
  "matchId": "2814995",
  "homeTeam": "阿森纳",
  "awayTeam": "切尔西",
  "league": "英超",
  "matchTime": "21:00",
  "scheduleMode": "today",
  "companies": [{ "companyId", "companyName", "openTime", "asianHomeInit", "asianLineInit", "asianAwayInit", "asianHomeLive", "asianLineLive", "asianAwayLive", "euroAsianHomeInit", "euroAsianLineInit", "euroAsianAwayInit", "totalOverInit", "totalLineInit", "totalUnderInit", "euroHomeInit", "euroDrawInit", "euroAwayInit" }],
  "crown12Handicap": { "home": "0.88", "line": "0.5", "away": "0.98" },
  "crown12Total": { "over": "0.87", "line": "2.5", "under": "0.93" },
  "crownLiveHandicap": { "home": "0.88", "line": "0.5", "away": "0.98" },
  "crownLiveTotal": { "over": "0.87", "line": "2.5", "under": "0.93" }
}
```

### 分析流程
1. **规则引擎**（本地计算，<1ms）：6项赔率指标，信号输出为"主降水/客降水/中立"
   - 盘口变化方向（权重25%）：多公司初盘→参照盘口对比（今日用crown12，未来用crownLive），盘口升=主降水信号，盘口降=客降水信号
   - 水位变化方向（权重15%）：初盘→参照水位变化，主水下降=主降水信号，客水下降=客降水信号
   - 公司分歧度（权重15%）：各公司盘口差异映射为水位方向
   - 欧亚偏差（权重20%）：欧转亚盘 vs 实际亚盘偏离方向，映射为水位方向
   - 开盘时间早晚（权重10%）：早开vs晚开公司盘口+水位差异，映射为水位方向
   - 大小球趋势（权重15%）：大小球盘口和水位变化
2. **Web Search**（~2-5秒）：搜索"{主队} {客队} 伤停 阵容 赛前分析"获取新闻情报
3. **LLM决策**（~3-5秒）：将指标+新闻+赛事信息+learned_patterns经验一起输入doubao-seed-2-0-lite模型，输出水位方向判断
4. **保存结果**: 自动存入prediction_results表（含water_direction字段），页面加载时从DB读取已有预测填充analysisResults

### 同盘口不同水位规则（CRITICAL，已验证）

**核心发现**: 当晚开公司与早开公司盘口相同时，水位变化比盘口变化更具参考价值。

**规则**:
1. **亚盘同盘口水位规则**: 晚开公司亚盘盘口与早开相同，但主水更低 → 资金持续流入主队 → 主降水强信号
2. **欧转亚同盘口水位规则**: 欧转亚晚开公司与早开盘口相同，但主水更低 → 市场在欧赔和亚盘两个维度都看好主队 → 主降水信号更强
3. **水位比盘口更关键**: 盘口不变时，水位变化反映庄家真实态度调整。盘口是"价格"，水位是"成本"，成本变化比价格变化更敏感

**代码实现**:
- 指标5（开盘时间早晚）: 增加早晚开公司主水/客水均值对比，盘口相同/接近时由水位信号决定水位方向
- 指标4（欧亚偏差）: trendDetail中追加亚盘早晚开主水水位变化信息
- LLM系统提示词: 规则8和9明确同盘口不同水位的判断逻辑

### 返回格式
```json
{
  "success": true,
  "data": {
    "matchId": "...",
    "indicators": [{ "name", "value", "signal": "主降水|客降水|中立|不确定", "weight", "reasoning" }],
    "newsSummary": "新闻摘要...",
    "llmPrediction": {
      "handicapTrend": "升盘|降盘|不变",
      "waterDirection": "主降水|客降水|不变",
      "prediction": "主|客|中立",
      "confidenceLevel": "高|中|低",
      "accuracy": "78%",
      "strategy": "一句话策略",
      "action": "0.5 0.89/0.97 主",
      "reasoning": "推理过程"
    },
    "crown_handicap": "0.5",
    "yinghe_handicap": "0.5",
    "who_open_later": "盈禾先开"
  }
}
```

### 前端交互
- **信息栏"AI分析"下拉菜单**: 分析首场赛事 / 批量AI分析 / 验证+学习 / 进化统计
- **赔率监控Tab"AI分析"下拉菜单**: 同信息栏
- **赛事行"AI"按钮**: 赔率监控Tab每行闪电图标，点击分析/展开结果（forceReanalyze=true强制重新分析）
- **数据Tab"AI"按钮**: 每场赛事旁的AI按钮
- **分析结果行**: 赛事行下方紫色背景行，显示水位方向(主降水/客降水)/方向/置信度/策略，点击"详情"展开指标和推理
- **历史模式**: 所有AI按钮禁用，信息栏显示"AI验证"而非"AI分析"

### AI分析获取完整数据流程（CRITICAL）
1. 前端 `analyzeSingleMatch` 调用 `/api/data/odds-db?date=xxx&matchId=xxx` 获取单场**非slim**完整数据
2. 非slim数据包含AI分析所需的所有字段：openTime、ftHandicapHomeLive、euroHome等
3. slim模式（`?slim=1`）删除了这些字段，仅用于前端展示
4. 如果非slim获取失败，回退使用slim的dbCompanyOddsMap（部分指标会显示"数据不足"）

### 依赖
- OpenAI兼容API（src/lib/llm.ts）— 支持任何OpenAI兼容端点
- 模型: 通过 `LLM_MODEL` 环境变量配置
- Web Search（可选）: 通过 `SEARCH_API_KEY` + `SEARCH_BASE_URL` 配置

## AI对话沟通API

**POST** `/api/analysis/chat` - 与LLM实时对话（SSE流式输出）

### 请求Body
```json
{
  "matchId": "2814995",
  "homeTeam": "阿森纳",
  "awayTeam": "切尔西",
  "league": "英超",
  "matchTime": "21:00",
  "messages": [{ "role": "user", "content": "阿森纳主力前锋伤缺，是否影响判断？" }],
  "analysisContext": "预测: 升盘 / 方向: 主 / 置信度: 高...",
  "liveHandicap": "0.5",
  "liveHomeOdds": "0.89",
  "liveAwayOdds": "0.97"
}
```

### 返回格式
SSE流式：`data: {"content": "..."}\n\n`，结束标记：`data: [DONE]\n\n`

## AI学习进化API

**GET** `/api/analysis/learn` - 获取学习统计和模式

**POST** `/api/analysis/learn` - 挖掘模式并更新权重
- Body: `{ "league": "ALL"|"英超", "minSamples": 3 }`
- 从prediction_results验证数据中挖掘1/2/3指标组合的高命中率模式
- 动态调整6项指标权重（准确率高的指标增权，低的减权）
- 结果存入learned_patterns表

**GET** `/api/analysis/verify?startDate=YYYYMMDD&endDate=YYYYMMDD` - 验证历史预测
- 对比预测的water_direction与实际水位方向（crown12水位→crown_live水位）
- 自动更新prediction_results的is_correct和actual_water_direction字段
- 返回总体验证统计和各指标/联赛/水位方向准确率

## 自动抓取逻辑（已验证，禁止修改）

### 抓取策略
1. **今日赛程**: 有赛事筛选→按筛选抓取，无筛选→自动抓取热门赛事 → 用户新增联赛后自动增量抓取
2. **历史赛程**: 同今日
3. **未来赛程**: 同今日

### 加载流程
1. 页面加载/切换赛程模式 → `loadOddsFromDb(date)` 从DB加载已保存赔率
2. DB加载完成1.5秒后 → `autoFetchHotMatches()` 自动抓取未保存的热门赛事
3. 热门赛事定义: `hotLeagueNames.has(m.league) || m.isHot` 且 `m.state === "0"`
4. 每个模式+日期组合只触发一次自动抓取（`autoFetchTriggered`状态控制）
5. 抓取后立即调用 `saveMatchOddsToDb()` 保存到数据库
6. 开盘时间异步获取后再次更新DB

### 增量抓取
- 用户添加联赛时，检测新增联赛中有哪些赛事尚未保存到DB
- 自动抓取这些新增赛事（800ms防抖，避免用户快速切换时频繁触发）
- 使用 `fetchedMatchesRef` 读取已抓取赛事，避免useEffect依赖循环

### 并发控制
- 批量抓取使用并发限制（每批3个赛事）
- 批间延迟300ms
- 支持中断（`autoFetchAbortRef`）

## 部署清单

### 部署时必须勾选
1. **数据库** — 8张表全选（daily_reports, learned_patterns, match_odds, prediction_data, prediction_results, league_selections, user_focused_leagues, app_settings）
2. **公开部署** — 建议勾选

### 环境变量配置
- **对象存储**: 已移除S3依赖，prediction和report API改用数据库
- **LLM**: 需配置 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL` 环境变量（OpenAI兼容协议）
- **Web搜索**（可选）: 配置 `SEARCH_API_KEY`、`SEARCH_BASE_URL` 环境变量，未配置则跳过新闻搜索

## 飞书机器人通知

### 配置方式
1. 在飞书群中添加"自定义机器人"，获取Webhook URL（格式：`https://open.feishu.cn/open-apis/bot/v2/hook/xxx`）
2. 在系统"飞书设置"中填入Webhook URL并保存
3. 点击"测试连接"验证

### 数据存储
- `app_settings` 表：`feishu_webhook_url` key
- 保存时同时写入环境变量 `FEISHU_WEBHOOK_URL` 和清除缓存
- `_helpers.ts` 缓存5分钟，支持env var和DB两种来源

### 通知场景
| 场景 | 触发时机 | 消息类型 |
|------|---------|---------|
| AI分析完成 | 单场/批量AI分析 | 富文本(赛事+水位方向+策略) |
| 定时任务完成 | 12:02抓赔率/12:10抓新数据/12:15 AI分析 | 富文本(任务名+数量+耗时) |
| 验证+学习 | 02:00自动验证 | 富文本(准确率+水位方向统计+高命中模式) |
| 赔率提醒 | 阈值触发 | 富文本(赛事+提醒类型+当前值) |

### API端点
- `GET /api/settings` — 获取设置
- `POST /api/settings` — 保存设置（body: `{ settings: { feishu_webhook_url: "..." } }`）
- `GET /api/feishu/notify` — 检查配置状态
- `POST /api/feishu/notify` — 发送消息（body: `{ text: "..." }` 或 `{ msg_type: "test" }`）

### 多人共享
- 所有API使用service_role_key，绕过RLS，多人同时使用都能正常读写数据库
- 预测数据(prediction_data)按日期存储，多人共享同一份数据

## ⚠️ 常见陷阱与已修复Bug（开发者必读）

### 1. 表格列对齐
- **亚盘/进球数必须用3个独立td**：主水(右) | 盘口(中) | 客水(左)
- **禁止单个td+inline-flex+固定宽度(w-7/w-8)**：table auto-layout中，盘口值较长（如"受0/0.5"）时会溢出，导致后续列错位
- 数据Tab和赔率监控Tab都必须遵守此规则

### 2. 赔率监控Tab赛事过滤
- API `/api/odds` 返回**所有状态**的赛事（未开赛+已开赛+已完赛）
- `filteredMatches` 必须过滤 `m.state === "0"`，否则已完赛/已开赛赛事会混入列表
- 已开赛/已完赛赛事通过 `otherStateMatches` 在"已完场置顶赛事"下方单独显示
- **赔率对比只计算未开赛赛事**：`oddsComparisonSummary` 必须过滤 `m.state !== "0"` 的赛事，已开赛/已完赛赛事的赔率已无意义

### 3. 公司排序
- 开盘时间格式为"M-D HH:MM"（如"4-6 17:19"）
- **禁止直接字符串排序**："4-6" > "4-16"（字符6>1），但实际4月6日在4月16日前
- **必须使用`normalizeOpenTime()`补零后再排序**："04-06" < "04-16"

### 4. 盘口升降判断（参考逻辑，用于指标计算）
- **数值体系**：主让球=正数（让0.5=+0.5），主受让=负数（受0.5=-0.5），平手=0
- **核心定义（让球方视角）**：升盘=盘口绝对值增大（让球方优势扩大），降盘=盘口绝对值减小（让球方优势缩小）
- **映射到水位方向**：升盘→主降水信号，降盘→客降水信号（盘口升=主队方向=资金流入主队）
- **验证基准（CRITICAL）**：验证用水位方向（crown12水位→crown_live水位），不再用盘口方向
- **判定方法**：比较初盘和终盘的**绝对值**，不能用原始数值差（diff）
  - |终盘| > |初盘| → 升盘（让球方优势扩大）
  - |终盘| < |初盘| → 降盘（让球方优势缩小）
  - 从让变受 或 从受变让 → 单独处理（跨越0点）
- **跨0点规则**（注意：平手=0不是"让球"，不触发跨0点规则）：
  - 从让变受（如让0.25→受0.25）：降盘（让球方从让球变成受让，优势大幅缩小）
  - 从受变让（如受0.5→让0.25）：升盘（让球方从受让变成让球，优势大幅扩大）
  - **平手→受让（如0→-0.25）= 升盘**（盘口从无到有，绝对值增大，不是"从让变受"）
  - **受让→平手（如-0.25→0）= 降盘**（盘口消失，绝对值减小，不是"受变让"）
  - 代码：`initLine > 0 && liveLine < 0`（不是`>=0`），`initLine < 0 && liveLine > 0`（不是`>=0`）
- 正确示例（绝对值比较）：
  - 让0.5(+0.5)→让0.75(+0.75)：|0.75|>|0.5| → 升盘（让球增多=让球方优势扩大）✓
  - 受0.5(-0.5)→受0.25(-0.25)：|0.25|<|0.5| → 降盘（受让减少=让球方优势缩小）✓
  - 受0/0.5(-0.25)→受0.5(-0.5)：|0.5|>|0.25| → 升盘（受让增多=让球方优势扩大）✓
  - 让0.25(+0.25)→受0.25(-0.25)：从让变受 → 降盘（让球方优势大幅缩小）✓
  - 受0.5(-0.5)→让0.25(+0.25)：从受变让 → 升盘（让球方优势大幅扩大）✓
- **水位容差规则**：盘口一致（绝对值差<0.01）+ 水位差≤0.03 = 预测正确（盘口没变且水位微调在合理范围）
- **禁止用原始值diff判定升降盘**：对受让盘，diff>0≠升盘！受0.5→受0.25的diff=+0.25但实际是降盘（|0.25|<|0.5|）
- 所有涉及升盘/降盘判断的地方（前端diff显示、后端规则引擎指标1/4/5、verify验证、report报表）**必须用绝对值比较**

### 5. 表头列数必须与数据行列数一致
- 赔率监控Tab数据行有14列（4按钮+联赛+时间+主队+亚盘3td+客队+进球数3td）
- 表头也必须有14个`<th>`（或用colSpan合并），缺少表头列会导致所有后续列错位

### 6. 数据Tab皇冠即时赔率位置
- 皇冠即时赔率（亚盘+进球数）放在**主队td内**（主队名称下方）
- **禁止**在主队和客队之间创建独立的"盘口"列
- 格式与亚盘(初)列一致：三段式，盘口在中间

### 7. 排名数据源
- **今日数据(bfdata_ut.js)**: 排名在 `A[i][22]`(主队) 和 `A[i][23]`(客队)，格式为"联赛+排名数字"如"土超7"
- **历史/未来数据(HTML)**: 排名在 `<td>[春14]</td>` 格式，用正则提取括号内数字
- **禁止**从 `A[i][5]`(主队名) 或 `A[i][8]`(客队名) 提取排名 — 这些字段不含排名信息
- 提取排名用 `extractRankFromField()` (JS数据) 或正则 `\[[^\]]+\]` (HTML数据)

### 8. 笔记3td对齐显示
- **主水td**: 即时主水 + 笔记主赔（选"主"时差值在主赔左方）
- **盘口td**: 即时盘口 + 笔记盘口值（用 `extractLineFromNote()` 提取）
- **客水td**: 即时客水 + 笔记客赔（选"客"时差值在客赔右方）
- 差值显示位置：选"主"→差值在主赔左侧（如 `-0.03 0.95`），选"客"→差值在客赔右侧（如 `0.89 +0.00`）
- 笔记格式："盘口 主赔/客赔 方向"，如"0/0.5 0.83/1.05 客"
- 盘口值在赔率对之前，用 `extractLineFromNote()` 提取（找到 `\d+\.\d+/\d+\.\d+` 之前的文本）

### 9. 已开赛/已完赛赛事显示
- 赔率监控Tab底部"已开赛/已完赛"区域，用 `otherStateMatches` 列表渲染
- `otherStateMatches` 过滤 `m.state !== "0"`，且受联赛筛选影响
- 已开赛/已完赛赛事行支持**展开功能**：点击展开按钮可抓取并查看公司赔率数据
- 赔率用灰色低对比度显示，不显示赔率对比差值
- 赛事状态标签：state=1→"进行"，state=-1→"完场"，state=2→"中场"

### 10. 统计栏布局
- 所有统计信息合并到顶部状态栏一行显示
- 格式：`X场赛事 | 共X场未开赛 | 显示X场 | 已开赛/已完赛X场 | 置顶X场 | 监控X场 | 笔记X条 | 对比X条 | 上次刷新: HH:MM:SS`
- 底部仅保留红绿图例（上升/下降）+ 基准输入框 + 底色切换器，不重复统计信息

### 11. 底色主题切换
- `BG_THEMES` 数组定义多种底色方案：深蓝、纯黑、石板、墨绿、酒红、棕褐、藏蓝、暗紫、暖灰
- 底部图例区显示色块按钮，点击切换全网页底色
- `bgTheme` 状态控制当前主题，通过 `currentTheme` 对象读取 bg/card/border 颜色
- 主容器和header使用 `style={{ backgroundColor: currentTheme.bg }}` 动态设置

### 12. 笔记数据结构
- `MatchNotes` 接口字段：
  - `handicapNote` / `totalNote`: 笔记文本（格式："盘口 主赔/客赔 方向"）
  - `handicapAmount` / `totalAmount`: 金额（纯文本输入，无功能逻辑）
  - `handicapSettled` / `totalSettled`: 已补勾选（boolean）
- **已补笔记不参与赔率对比**：`oddsComparisonSummary` 和行内差值显示均跳过 `settled=true` 的笔记
- 基准总赔率通过底部图例区的输入框设置（默认1.88），`oddsBaseTotal` 状态控制

### 13. 皇冠新数据（crown_12_odds）
- **含义**: 从changeDetail页面抓取的皇冠开盘赔率（亚盘+进球数"即"状态最后一行全场数据）
- **数据源**: changeDetail/handicap.aspx + overunder.aspx（companyid=3），取"即"状态最后一行全场数据（开盘赔率）
- **抓取时机**:
  - 今日赛程: 北京时间12:10由定时任务抓取（`fetchCrown12Odds`），页面加载时若已过12:10则立即执行
  - 历史赛程: fetchSingleMatchOdds后异步抓取（`if (dataScheduleMode === "history")`）
  - 未来赛程: 暂不抓取
- **显示位置**: 客队名称下方（无标签），今日+历史模式显示，未来模式不显示
- **API**: GET /api/data/match/{id}/crown-live

### 14. 皇冠终盘（crown_live_odds）显示规则
- **今日模式(state=0)**: 主队下方显示goalBf3.xml即时赔率（实时刷新）
- **今日模式(state!=0)**: 主队下方显示终盘（crown_live_odds，标签"终盘"，灰色）
- **历史模式**: 主队下方显示终盘（所有比赛已完场）
- **未来模式**: 主队下方显示goalBf3.xml即时赔率（暂不做更改）
- **终盘数据来源**:
  1. 抓取 /analysis/odds/ 时，优先使用皇冠(companyId=3)的liveOdds字段作为终盘
  2. 无liveOdds时，回退使用goalBf3.xml即时赔率
  3. 对state!=="0"的历史赛事也保存终盘数据（不仅限于未开赛）
- **无终盘数据时不显示**

### 15. 历史赛程日期范围选择
- 历史模式支持日期范围：起始日期 ~ 结束日期（如2026-04-20 ~ 2026-04-23）
- 选择范围后逐日调用 `/api/schedule?date=YYYYMMDD&mode=history`
- 合并所有日期的赛事和联赛数据，逐日从DB加载赔率
- 今日模式仍是单日，未来模式保持单日期选择
- 加载过程显示进度（"加载中 3/4 天..."）

### 16. 历史赛程比分显示
- 数据Tab历史模式增加"比分"和"半场"两列（表头和数据行）
- 比分数据来自 /api/schedule 解析的HTML（td[4]=全场比分, td[6]=半场比分）
- 格式：全场"2-1"，半场"1-0"
- 今日/未来模式不显示比分列

### 17. Excel导出
- 数据Tab信息栏"导出Excel"按钮，使用xlsx库在客户端生成
- Excel列：日期|联赛|时间|状态|比分(历史)|半场(历史)|主队|客队|终盘6列(历史)|新数据6列|开盘时间|公司|亚盘(初)3列|欧转亚盘(初)3列|进球数(初)3列
- 文件名格式：`赔率数据_YYYYMMDD-YYYYMMDD.xlsx`
- 仅导出当前已加载+已抓取的数据

### 18. 补充抓取与数据覆盖保护
- **补充抓取4选项**: 缺失赔率/缺失开盘时间/缺失新数据/缺失终盘
- **中止抓取**: 抓取进行中显示"中止抓取"按钮，点击立即停止
- **刷新检测**: 补充抓取下拉菜单含"刷新检测"按钮，实时更新缺失数量
- **re-fetch数据合并**: `fetchSingleMatchOdds`创建newEntry时，检查`dbCompanyOddsMap`中已有条目，保留已有开盘时间数据（`existingOpenTimes`），避免覆盖
- **DB crown字段保护**: odds-db POST API仅当crownLiveOdds/crown12Odds有实际数据时才包含在upsert中，避免空对象覆盖已有数据
- **crownLiveOddsFromDb状态同步**: `fetchSingleMatchOdds`提取crownLive后立即调用`setCrownLiveOddsFromDb`更新前端状态，确保终盘数据即时显示

### 19. 性能优化（大数据量场景）
- **批量DB加载**: `loadOddsFromDbRange`并行获取多天数据(3并发)，合并后一次性setState，避免逐日调用导致的级联重渲染(10天40次→1次)
- **useMemo缓存**: `dataMatchRows`预计算过滤+排序+赔率关联，避免渲染函数内联IIFE每次重渲染都重新计算
- **分页显示**: Data Tab每页200场，5985场赛事不再全部渲染DOM(上万节点→几百节点)，翻页/跳页控件
- **DB API slim模式**: `?slim=1`参数只返回展示所需12个公司字段(省略12个live/euro字段)，0401单日从10.3MB降至5.3MB(减48%)。AI分析时必须使用非slim模式获取完整数据（含openTime/liveOdds/euroOdds等），通过`?matchId=xxx`只获取单场完整数据避免大数据量传输
- **normalizeOpenTime函数**: 必须定义在组件外部(非组件内const)，否则useMemo因JS hoisting报"Cannot access before initialization"

### 20. AI分析数据源问题（已修复）
- **问题**: slim模式删除了AI分析需要的字段(ftHandicapHomeLive/euroHome/openTime等)，导致"开盘时间早晚:数据不足"
- **修复**: `analyzeSingleMatch`调用`/api/data/odds-db?date=xxx&matchId=xxx`获取单场非slim完整数据
- **禁止**: 用slim模式的dbCompanyOddsMap作为AI分析数据源（字段不完整）

### 21. AI分析即时赔率问题（已修复）
- **问题**: AI分析使用实时即时赔率，同一赛事不同时间分析方向翻转（推荐客→推荐主）
- **修复**: 移除即时赔率依赖。今日用crown12(稳定开盘赔率)，未来用crownLive(相对稳定)，历史禁用AI分析
- **禁止**: 将goalBf3.xml即时赔率传入AI分析请求

### 22. S3对象存储已移除
- **原设计**: prediction和report API使用S3存储预测数据
- **问题**: 部署面板没有对象存储选项
- **修复**: 全部改用数据库prediction_data表，API使用Supabase读写
- **禁止**: 引入S3Storage或COZE_BUCKET_*环境变量

### 23. JSX语法陷阱
- **禁止**在三元表达式的分支内使用`{condition && (...)}`，会导致语法错误
- 正确写法: `condition ? (...) : null`
- 错误写法: `a ? b : {c && (<d/>)}`  ← 解析器会把`{`当作对象字面量

### 24. edit_file字符串匹配
- 修改文件后上下文变化，导致old_string不匹配
- 修复方法: 重新grep/read定位行号，用更精确的上下文
- rename变量后，必须grep检查所有引用并逐一替换(replace_all)

### 25. let→const lint规则
- analysis/route.ts 和 verify/route.ts 中 `let cleanLine` 应为 `const cleanLine`
- cleanLine只赋值一次，用let会触发lint警告

### 26. handicapLineToNumber 中 `*` 前缀含义（CRITICAL）
- 源网站数据中 `*` 前缀表示"初盘/opening odds"标记，**不是"受让"**
- `*平/半` = 主让平/半(+0.25)，不是受让平/半(-0.25)
- 只有 `受` 或 `受让` 前缀才表示受让（盘口值取负）
- **禁止**在 `handicapLineToNumber` 函数中将 `line.startsWith("*")` 作为 `isReceiving` 判断条件
- 正确做法：先 `line.replace(/^\*/, "")` 去掉 `*`，再检查 `受`/`受让` 前缀
- 此bug存在于 analysis/route.ts 和 verify/route.ts 两个文件，已修复

### 27. handicapLineToNumber 中文盘口映射不全（CRITICAL）
- `平/半` split后为 `["平", "半"]`，需要 `chineseMap["平"]=0` 和 `chineseMap["半"]=0.5`
- `半/一` split后为 `["半", "一"]`，需要 `chineseMap["半"]=0.5` 和 `chineseMap["一"]=1`
- 缺少 `"平":0`, `"半":0.5`, `"一":1`, `"两":2`, `"三":3`, `"四":4`, `"球半":1.5` 映射
- 导致 `平/半`、`半/一`、`一/球半`、`两/两球半`、`球半/两` 等组合盘口全部解析为 NaN
- 此bug导致验证API大量赛事无法验证（仅16/103可验证→88/103修复后）

### 28. analysis API match_date 存储日期错误（CRITICAL）
- 旧代码用 `new Date()` 取当天日期作为 `match_date` 存入 prediction_results 表
- 分析4月23日赛事时，match_date 被存为 20260426（当天日期）
- 导致 verify API 按 match_date=20260423 查询时找不到任何预测结果
- 修复：请求体增加 `matchDate` 字段，API 优先使用请求中的 `matchDate`，回退使用当天日期
- 前端调用分析API时传入 `currentDbDate` 作为 `matchDate`

### 29. 初始mount effect缺少 loadPredictionsFromDb 调用（CRITICAL）
- 初始 mount effect（`useEffect([currentDbDate])`）只调用了 `loadOddsFromDb` 和 `loadLeagueSelections`
- **遗漏**了 `loadPredictionsFromDb` 调用，导致 `analysisResults` 始终为空
- 后果：所有赛事被判定为"未分析"，刷新页面后AI分析重新执行
- 修复：初始 mount effect 添加 `loadPredictionsFromDb(currentDbDate)` 调用
- 同时在模式切换时清空 `analysisResults` 和 `analysisResultsRef`，避免旧数据残留

### 30. 优先级规则体系（Priority Rule Engine）
- **背景**: learn API挖掘的207个模式缺乏优先级区分，LLM无法区分核心规则和弱信号
- **实现**: 在analysis route中硬编码优先级规则引擎（`PRIORITY_RULES`数组），按命中率+样本数分级
- **优先级定义**:
  - P0核心规则：100%命中率+>=5场样本，匹配时LLM必须以此方向为主，置信度提升一级
  - P1强信号：90%+命中率（或100%+3-4场），高参考价值
  - P2辅助确认：75-90%命中率，提供方向参考
  - P3弱势信号：60-75%命中率，仅作补充
  - RED负面警示：<60%命中率，匹配时应降低置信度或考虑反向
- **"中立"含义**: 该指标升盘/降盘数量相当或盘口无变化，不提供明确方向，但组合其他指标时有确认/否定作用
- **匹配逻辑**: `matchPriorityRules()`将6项指标信号映射为IndicatorKey，逐条检查PRIORITY_RULES条件
- **注入方式**: `buildPriorityContext()`构建分优先级的文本注入LLM系统提示词，同时`priorityRules`字段返回前端
- **核心发现**（基于811场验证数据）:
  - 分歧度中立+开盘时间升盘 = 最强组合(96.8%, 63场)
  - 水位升盘+分歧度中立+欧亚偏差降盘 = 黄金组合(90.9%, 66场)
  - **一致性偏见**: 所有指标同向时反而命中率极低(如盘口+水位+欧亚全升=16.7%)
  - 降盘方向预测偏激进(42.3%)，不变预测最准(87.4%)
- **DB字段**: `prediction_results.priority_rules_json` 存储匹配结果JSON（matched规则列表+topPriority）
- **learned context调整**: 通用模式不再从DB加载（已硬编码为PRIORITY_RULES），只加载联赛专属模式

### 31. verify实际趋势判断修复（CRITICAL）
- **问题**: 旧verify只用皇冠(companyId=3)一家的init vs live判断"实际趋势"，但皇冠盘口可能没变而其他公司已经调整
- **案例**: 杜连斯vs化夫 — 皇冠init=live=半/一(不变)，但平博1→0.75(降盘)、36bet 1→0.75(降盘)、1xbet 1.25→0.75(降盘)
- **修复**: 改为综合所有公司的init vs live变化，多数公司一致(>=40%)即判断为升盘/降盘
- **影响**: 4月23日验证结果从88场→103场(多15场可验证)，不变从38→46，升盘+降盘准确率显著提升(升盘80.6%/降盘92.3%)

### 32. 让球方向缺失bug（CRITICAL，已修复）
- **问题**: `/analysis/odds/`端点返回的亚盘line字段（如"半球"）不区分让球/受让方向。"半球"既可能是主让0.5(+0.5)也可能是主受0.5(-0.5)。`handicapLineToNumber()`将所有"半球"都返回+0.5，导致约25%赛事（客队让球时）的升盘/降盘方向完全相反
- **根因**: 网站返回的亚盘数据不包含"受"前缀，需要用欧赔判断方向：
  - euroHome < euroAway → 主队热门 → "半球"=主让0.5(+0.5)
  - euroHome > euroAway → 客队热门 → "半球"=主受0.5(-0.5)，应加"受"前缀
- **修复**: 在`/api/data/match/[id]/route.ts`的`parseCompOddsData()`中新增`fixHandicapDirection()`函数，用欧赔判断方向后给客队热门赛事的亚盘line加"受"前缀
- **欧转亚盘同样受影响**: euroAsianLine也需要同样的方向修正
- **DB批量修复**: 4月23日38条+4月26日215条，共253条match_odds记录需批量修复（脚本`fix_handicap_direction.py`）
- **影响范围**: 所有依赖`handicapLineToNumber()`的地方都受影响——analysis规则引擎6指标、verify验证、learn学习、前端升盘/降盘显示
- **旧预测清除**: 修复后旧预测的升降盘方向不可信，需删除重新分析
- **analysis API upsert修复**: 重新分析时需重置is_correct/actual_handicap_trend/verified_at字段（upsert时显式设为null）
- **用户提供的正确定义**: 升盘=让球方优势扩大(让球数增加)，降盘=让球方优势缩小(让球数减少)

### 33. AI验证/学习排除数据不完整赛事（CRITICAL）
- **问题**: 历史赛程中数据不全(缺终盘/皇冠新数据)的赛事也被AI验证和学习使用，导致验证结果和机器学习方向错误
- **修复1 - verify API**: 添加数据完整性检查，只有crown_live_odds非空且有handicapLine值的赛事才参与验证
- **修复2 - learn API**: 挖掘模式时查询match_odds表验证crown_live_odds有效性，排除数据不完整的已验证预测
- **修复3 - 历史数据清理**: SQL重置195条被不完整数据验证过的prediction_results(is_correct=null)，清除434条旧learned_patterns
- **结果**: 886条已验证→691条有效验证(195条重置)，learn API输出excludedIncomplete字段

### 34. 赛事排序修复（CRITICAL）
- **问题**: 数据Tab未开赛赛事不按原网站排序，report报表也不按联赛+时间排序
- **修复1 - dataTab**: `notStarted`数组添加`.sort((a, b) => a.orderIndex - b.orderIndex)`排序
- **修复2 - report API**: report rows按league名排序+同联赛按match_time排序

### 35. 数据校验功能
- **新增**: 补充抓取下拉菜单添加"数据校验(已抓取赛事)"按钮
- **功能**: 重新抓取所有已有DB数据的赛事赔率，对比并自动更新DB
- **类型**: `supplementFetch("revalidate")` — 对已fetchedMatches的赛事重新fetchSingleMatchOdds
- **用途**: 修正DB与源站不一致的数据，特别是终盘、盘口方向等

### 36. handicapLineToNumber parseFloat优先级bug
- **问题**: `parseFloat("3.5/4")`返回3.5而非NaN，导致组合格式被错误解析为单个数值
- **影响**: report/analysis/verify三个API中，"3.5/4"应解析为3.75但被解析为3.5
- **修复**: 将split拆分逻辑移到parseFloat之前执行
- **位置**: report/route.ts, analysis/route.ts, verify/route.ts

### 37. `*受`前缀顺序bug
- **问题**: `*受一/球半`格式中，`*`前缀检测在`受`之前，导致isReceiving=false，解析结果符号错误
- **修复**: 先去掉`*`前缀，再检测`受/受让`前缀（report route.ts）

### 38. 报表"预测对错"列
- **旧版**: "方向"列显示`+/-`符号，不直观
- **新版**: "预测对错"列显示绿色"对"/红色"错"标签
- **水位容差标识**: 水位容差判定正确的行额外显示黄色"水"标记
- **手动纠正**: ✓/✗按钮手动标记对错，纠正后显示"手"标记
- **撤回功能**: 手动纠正后可点↩按钮撤回（API支持isCorrect=null重置）
- **大小球列**: 同样改为"对/错"标签显示

### 39. 盘口不变时用水位变化判断推荐方向（CRITICAL）
- **问题**: 旧逻辑"盘口不变=预测正确"，导致预测"不变"+推荐"主"但主水上升(不看好主队)的赛事也被判正确
- **案例**: 艾巴辛尼vs维拉斯尼亚——初盘平手(主0.83)→终盘平手(主0.90)，推荐主队，但主水上升0.07=资金流出主队=预测错误
- **修复**: 盘口不变时，用水位变化判断推荐方向是否正确：
  - 推荐主 + 主水下降(资金流入主队) → 正确
  - 推荐主 + 主水上升(资金流出主队) → 错误
  - 推荐客 + 客水下降(资金流入客队) → 正确
  - 推荐客 + 客水上升(资金流出客队) → 错误
  - 水位变化极小(≤0.03) → 不变算正确(水位容差)
  - 无水位数据 → 预测"不变"算正确
- **影响**: verify API + report API + 前端验证逻辑
- **数据**: 4月27日"不变+主"64场：旧逻辑100%正确→新逻辑43.8%正确；整体准确率从75.8%降至54.0%

### 40. 双模式验证：盘口一致用降水验证，盘口不一致用升降盘验证（CRITICAL）
- **核心规则**: 验证水位方向预测(主降水/客降水)时，根据盘口是否变化选择不同验证方式
- **方式1 - 盘口一致**（crown12盘口=crown_live盘口，绝对值差<0.25）：
  - 用水位变化方向验证：crown12主水→crown_live主水，主水下降→主降水，客水下降→客降水
  - 水位容差：水位差≤0.03时视为正确（盘口不变+水位微调=方向不明=正确）
  - 更精确地反映市场在盘口不变时的真实态度
- **方式2 - 盘口不一致**（crown12盘口≠crown_live盘口）：
  - 用升降盘规则验证：先判断实际升盘/降盘（新数据盘口→终盘盘口绝对值比较）
  - 升盘→让球方优势扩大→让球方水位应下降→验证映射
    - 主让盘升盘→主降水正确，客让盘升盘→客降水正确
    - 主让盘降盘→客降水正确，客让盘降盘→主降水正确
  - 反之则为错误
- **让球方识别**: crown12.handicapLine > 0 → 主让球，< 0 → 客让球
- **验证基准**: crown12(新数据)→crown_live(终盘)，不是初盘→终盘
- **实际盘口方向存储**: `actual_handicap_trend` 字段（升盘/降盘/不变）
- **实际水位方向存储**: `actual_water_direction` 字段（主降水/客降水/不变）
- **is_correct判定**: 基于双模式验证结果

### 41. 水位容差判定修正（CRITICAL）
- **盘口一致+水位差极小**: 盘口不变+水位差≤0.03时，不管预测方向是什么都返回true（方向不明=无法判断=正确）
- **盘口一致+水位差明显**: 用水位变化方向验证预测
- **盘口不一致**: 用升降盘映射验证，不受水位容差影响
- **无水位数据时**: 盘口一致则返回true（方向不明），盘口不一致用升降盘规则

### 42. AI预测范式转变：从盘口升降到水位方向（CRITICAL）
- **旧范式**: 预测handicap_trend(升盘/降盘/不变)，验证基于盘口方向
- **新范式**: 预测water_direction(主降水/客降水/不变)，双模式验证
- **核心原因**: 63.7%赛事盘口不变，预测盘口升降几乎无意义；水位变化更频繁更敏感
- **信号映射**: 升盘→主降水信号(盘口升=让球方被看好→资金流入→水位下降)，降盘→客降水信号
- **prediction_results新增字段**: water_direction(预测水位方向), actual_water_direction(实际水位方向)
- **双模式验证规则**:
  - 盘口一致→用水位变化方向验证（主水下降=主降水，客水下降=客降水）
  - 盘口不一致→用升降盘映射验证（升盘→让球方降水正确，降盘→受让方降水正确）
- **report API**: 报表列"水位方向"，验证结果基于双模式waterResult
- **前端显示**: AI结果标签"▼主降水/▼客降水"，蓝色=主降水，橙色=客降水
- **learn API**: 信号过滤"主降水/客降水/中立"
- **handicapTrend字段保留**: 作为参考，actual_handicap_trend存储实际盘口变化方向

### 43. goalBf3.xml 不是皇冠赔率（CRITICAL）

- **问题**: goalBf3.xml（赔率监控Tab主行数据源）返回的即时赔率**不是皇冠(Crow*)的赔率**，而是网站汇总的其他公司数据
- **案例**: 圣何塞地震 vs XX — goalBf3显示"0.87 半球 1.01"，皇冠真实即时赔率应为"1.08 一球 0.80"
- **修复**:
  - **数据Tab**: `renderHomeOdds()` 中，已抓取赛事优先使用 `companies.find(c => c.companyId === "3")` 的 DB 皇冠即时赔率，无 DB 数据时才用 goalBf3.xml 兜底
  - **赔率监控Tab**: `filteredMatches.map()` 中计算 `effective*` 变量（effectiveHomeOdds/effectiveHandicap/effectiveAwayOdds/effectiveOverOdds/effectiveTotalLine/effectiveUnderOdds），优先使用 DB 皇冠即时赔率
  - **AI分析/对话**: `analyzeSingleMatchCore` 和 `sendChatMessage` 中，crownLiveHandicap/crownLiveTotal/liveHandicap/liveHomeOdds/liveAwayOdds 优先使用 DB 皇冠数据
  - **颜色区分**: DB 皇冠数据显示为 emerald 色（text-emerald-300），goalBf3.xml 兜底数据使用原有变化颜色
- **字段映射**: `CompanyOddsItem` 接口中，初盘字段为 `ftHandicapHome/ftHandicapLine/ftHandicapAway`（无Init后缀），即时字段为 `ftHandicapHomeLive/ftHandicapLineLive/ftHandicapAwayLive`
- **禁止**: 将 goalBf3.xml 数据直接作为皇冠赔率显示给用户
