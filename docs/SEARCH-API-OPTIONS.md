# 中文搜索 API 选型调研（2026-11-05）

> 背景：小羽的 `qq_browse` 撞上字典页（「手冲咖啡的细节参数」→ 10 条全是「手」的
> 汉典/百度百科释义）。已定为走 `dsh-free-search` 的 `engine: 'auto'` 兜底，
> 但 `auto` 里的 keyless 引擎中文质量不稳定。本文调研四个 key-based 中文引擎。

## 一、结论先行

| 优先级 | 引擎 | 理由 |
|---|---|---|
| **1** | **豆包（火山 `feedcoop`）** | **每月 500 次免费**，字节自家中文语料，中文长尾最对症；官方 API、独立搜索端点，不绑模型 |
| 2 | 阿里云百炼 `EnhancedSearch` | 走 MCP 协议，同样是搜索专用；需查配额 |
| 3 | Kimi（Moonshot） | `$web_search` 官方工具，中文质量好，但**按 token 计费**且需充值 ≥10 元解锁旗舰 |
| 4 | 百度千帆 | `baidu_search_v2`，中文最全，但百度系结果广告/SEO 污染重，需实测 |

**推荐先从豆包开始**：500 次/月对"小羽一天查几次"完全够用，且零成本。

## 二、四个引擎的技术细节（从 dsh-free-search 源码读出，非猜测）

插件版本 `dsh-free-search 0.9.22`，四个引擎都已内置，**加 key 即用，不用改代码**。

### 1. 豆包（Doubao）

| 项 | 值 |
|---|---|
| 环境变量 | `DOUBAO_SEARCH_API_KEY` |
| 端点 | `https://open.feedcoopapi.com/search_api/web_search` |
| 请求体 | `{Query, SearchType:"web", Count, NeedSummary:true, Filter:{NeedUrl:true}}` |
| 时间过滤 | 支持 `TimeRange` |
| 免费额度 | **500 次/月**（代码注释 + 错误码 10406 双重确认） |
| 错误码 | 10403 权限 · 10406 额度耗尽 · 700429 限流 · 700901 key 无效 |
| 结果字段 | `Result.WebResults[]`：Url / Title / Summary / Content / Snippet / PublishTime |

申请处：火山引擎控制台 → **联网搜索**（不是普通方舟推理，要 Web Search console 的 key，
普通 Ark key 会报 `10403 TorrentlightApiFullAccess`）。

### 2. 百度千帆

| 项 | 值 |
|---|---|
| 环境变量 | `BAIDU_API_KEY` |
| 端点 | `https://qianfan.baidubce.com/v2/ai/...` |
| 请求体 | `{messages, search_source:"baidu_search_v2", resource_type_filter:[{type:"web",top_k}], search_filter}` |
| 时间过滤 | 支持 `search_filter.range.page_time` |
| 特点 | 中文覆盖最全；但百度系结果 SEO/广告污染较重，需实测 |

### 3. Kimi（Moonshot）

| 项 | 值 |
|---|---|
| 环境变量 | `KIMI_API_KEY`（代码里也认 `MOONSHOT_API_KEY`） |
| 端点 | `https://api.moonshot.cn/v1/tools/search` |
| 特点 | 官方 `$web_search` 内置工具，中文质量好 |
| 计费 | **按 token 计费**，旗舰模型需充值 ≥10 元解锁 |
| 注意 | 它的搜索是"模型内置工具"，返回带模型整理的摘要，不是纯链接列表 |

### 4. 阿里云百炼

| 项 | 值 |
|---|---|
| 环境变量 | `DASHSCOPE_API_KEY` |
| 端点 | `https://dashscope.aliyuncs.com/api/v1/mcps/EnhancedSearch/mcp` |
| 协议 | **MCP**（不是普通 REST），插件已适配 |
| 特点 | 阿里云百炼的联网搜索，中文电商/生活类内容覆盖好 |

## 三、和当前问题的匹配度

小羽的痛点是 **中文长尾口语化查询**：「手冲咖啡 研磨度 C40 刻度 经验」。
这类查询的特征：
- 词序口语化，搜索引擎容易断错词（Bing 断成「手」）
- 需要"人写的经验帖"，不是百科定义
- 长尾、小众领域

| 引擎 | 对这类查询的预期 |
|---|---|
| 豆包 | 好。字节的中文语料 + 自家分词，口语长尾理解强 |
| Kimi | 好，但会给你"模型总结"而非原始链接，对她"找素材"的场景略隔一层 |
| 阿里云 | 中等偏上 |
| 百度 | 中文覆盖最好，但结果含 SEO 农场，需配合现有 `isMeaningful` 过滤 |
| **Bing（现状）** | **差，就是当前问题的根源** |

## 四、配好之后会自动怎么走

`auto` 路由的 fallback 顺序（插件默认）是：

```
exa → tavily → keenable → firecrawl → parallel → perplexity → serpbase →
serply → deepseek-tools → deepseek-official → you → baidu → kimi → aliyun →
doubao → tinyfish → jina → bing → anysearch → ddg → ddg-lite → searxng → ...
```

注意：**加了 key 之后，baidu/kimi/aliyun/doubao 会自然进入这条链**，
不需要额外配置。但因为它们在链里位置靠后，实际多数请求可能被前面的 keyless
引擎（exa/anysearch）先接住——这未必是坏事（快且免费）。

如果想让中文查询**优先走豆包**，有两种做法：
1. `fallbackOrder` 配置里把 `doubao` 提到前面（插件支持）；
2. 或者干脆把小羽的 `qq_browse` 固定 `engine: 'doubao'`（但那样 keyless 全废，不划算）。

**建议先只加 key，观察 `auto` 的实际命中率，再决定要不要调顺序。**

## 五、下一步（需要你做的事）

1. **申请豆包 key**（推荐，免费 500/月）：
   火山引擎 → 联网搜索控制台 → 创建 API Key
2. 把 key 给我（或你自己填到 profile 的 `web-search-free` 配置里）：
   ```yaml
   - id: web-search-free
     config:
       doubaoApiKey: '你的key'
   ```
3. 重启一次（`patchReload: startup`）
4. 验证：让她再查一次手冲咖啡，看回来的是刻度干货还是字典页

## 六、一个必须提醒的点

配了 key 也**不能保证**她一定不再出字典页，因为：
- `qq_browse` 走 `engine:'auto'`，最终命中哪个引擎是运行时决定的
- 如果 keyless 引擎先接住且返回垃圾，key-based 的不会被轮到

所以配好之后，**建议实测几次再决定要不要固定引擎**。这也是为什么
我在代码里没把 `engine` 写死成某个具体引擎——留了 `auto` 让它自己找。

---

参考资料：
- 插件源码：`~/.dsh/profiles/web/node_modules/dsh-free-search/lib/index.js`
  （端点/请求体/错误码均从此处读出，行号见各表）
- Kimi 官方文档：https://platform.kimi.com/docs/guide/best-practices-for-web-search
- 火山引擎：https://www.volcengine.com/
## 七、实测落地结果（2026-11-06）

用户提供了两个 key，结果完全不同，值得记：

| key | 结果 |
|---|---|
| `ark-` 前缀 key（方舟推理） | ❌ 联网搜索端点报 `700901 invalid api_key`（稳定复现）<br>✅ 但列模型端点 200，能列出 53 个模型 → **key 本身有效** |
| 32 位无前缀 key（联网搜索） | ✅ **成功**，5 条结果全对题 |

**关键判据**：`ark-` 前缀 = 方舟推理 key，**不能**用于联网搜索。要另外去
火山引擎的「联网搜索」控制台开通并建 key。当时那个 ark key 连 `10403`
（权限不足）都没到，直接被判「不是搜索 key」。

用正确 key 实测「手冲咖啡 研磨度 C40 刻度 经验」返回：
- 知乎《那些年我用过的手摇磨豆机之 德国 司令官 C40》
- 什么值得买《为什么说C40是手摇磨豆机的天花板》
- 咖啡知识网《Comandante C40手磨咖啡机使用全指南》
- 网易《冰手冲咖啡的完美配方:研磨度、水温与冰块比例详解》
- 《分享2年使用经验 Comandante C40磨豆机使用评测》

全是真经验帖。对比之前的汉典/百度百科「手」字释义，天差地别。

### 最终配置（已写入 profile）

```yaml
# ⚠️ searchProvider 必须写【已注册的 provider id】，不是引擎名！
# free-search 只注册了一个 id：`ddg`（它内部才是多引擎容器，靠 request.engine 选引擎）。
# 我一开始写成 auto，结果抛 WEB_PROVIDER_CONFIGURED_MISSING
# → ctx.web.search 失败 → searchViaWeb 返回 null → 静默退回 Bing → 又是字典页。
- id: web
  config:
    searchProvider: ddg           # 必须是 ddg（provider id）
    fetchProvider: fs-quality-fetch
- id: web-search-free
  config:
    doubaoApiKey: '<32 位联网搜索 key，已配置在 profile，不入库>'
```

**真正的引擎选择靠代码里的 `request.engine: 'auto'`**（surf.ts 的 searchViaWeb），
它优先于 `cfg.provider`，走智能路由 + 全引擎 fallback 链。
两个都得对：provider id 必须合法，engine 必须显式传 auto。

生效方式：profile 是 `patchReload: startup`，**改完要重启**。
## 八、最终根因：中文池里没有豆包（2026-11-06）

小羽自己修好了 `ctx.web` 注入（她的提交 `1a50621`：`inject` 里没有 `'web'`，
cordis 访问守卫直接拒绝读 `ctx.web`，而我那个 try/catch 把它吞成了 undefined
→ `webSearch` 恒为 undefined → 永远走 Bing）。这是对的，且比我三个轮的
「软注入/配置/阈值」都更根本。

但今早她 surf 定时轮次仍跑偏，`debug-surf.jsonl` 实录：

    10:31  "一刀流 三段式 手冲 区别"
           → 首条「技术实现思路1、本发明提供一种三作业线三段式的备刀方法」
           ← 这是**机械加工专利**，跟手冲咖啡毫无关系

排查到最后一块拼图（`dsh-free-search/lib/index.js:383`）：

    const DEFAULT_ZH_POOL = ["bing", "baidu", "aliyun", "anysearch"];

**中文查询走 `zhPool`，而默认中文池里根本没有豆包。** 所以：
- 只配 `fallbackOrder` 没用 —— 豆包排第一，但中文查询压根不会路由到它；
- 中文池第一个是 `bing`，本机连不上/断词 → 给「一」的字典页或备刀专利；
- 豆包配了 key 也一直轮不到。

### 修法：显式配 zhPool

```yaml
- id: web-search-free
  config:
    doubaoApiKey: '<key>'
    fallbackOrder: [doubao, exa, anysearch, bing, ddg]
    zhPool: [doubao, baidu, anysearch, bing]   # ← 关键，把豆包塞进中文池首位
```

### 修复前后对照（真实 cordis + 真实 WebRuntime + 真实 free-search 验证）

| 查询 | 修复前 | 修复后 |
|---|---|---|
| 一刀流 三段式 手冲 区别 | 三作业线三段式的**备刀**方法（机械专利） | 常见的手冲咖啡冲煮方法 一刀流和段式的区别 |
| 手冲咖啡的细节参数 | 咖啡先生…（泛科普） | 手冲咖啡进阶指南:从研磨到注水（CSDN） |
| 研磨度 C40 刻度 | — | 那些年我用过的手摇磨豆机之 德国 司令官 C40 |

### 这一轮踩的教训

1. `auto` 不是「随便试所有引擎」，它先按**语言池**分组，只在池内按 fallback 排序。
   配了引擎的 key 却不进对应语言池 = 白配。
2. 我之前用「手写的假 web 对象」验证，得出「provider unavailable」的结论 ——
   那是自己编的，纯属自欺。这轮改用真 cordis + 真 WebRuntime + 真 free-search 才看到真相。
3. 进程 stdout 是管道，`logger.info` 不落盘；诊断必须 `appendFileSync` 写文件。
