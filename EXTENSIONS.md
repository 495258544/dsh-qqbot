# 本地扩展清单（相对上游 fork）

本仓库在 `495258544/dsh-qqbot` 之上叠加了一批**自研功能**。上游由另一个人维护、会不定期更新，
这份清单用来回答两个问题：

1. 哪些东西是我们加的（出问题先看这些）？
2. 合并上游时，哪些文件最可能冲突、冲突时该保留谁？

> 约定：`work` 分支放我们的改动；`main` 只用于同步上游，不直接提交业务改动。

## 〇、模块边界（2026-11-10 定稿，cherry-pick 先读这节）

src 按目录分成两层，**接缝只有一处**（`bootstrap.ts`）：

```
src/
├─ 聊天核心（改这里 = 同步"聊天修订"）          ← work 分支 cherry-pick 的范围
│   transport/  session/  persona/  commands/
│   middleware/  features/  media/  ops/  host/
└─ 平台扩展（每个目录自成一体，挂了不牵连聊天）  ← 按平台单独挑
    nga/    NGA 读帖/搜索/扫码登录（自带 registerNgaTools）
    xhh/    小黑盒只读（registerXhhTools）
    steam/  群友 Steam 状态（registerSteamTools）
    dota/   Dota 战绩（registerDotaTools）
    bili/   B站输出字段自检（checkBiliHealth，主体走官方 MCP）
    shared/ego-locate.ts  ego 可选依赖定位（surf 用，非平台）
```

三条硬规矩：

1. **平台模块禁止被聊天核心 import**。聊天核心（persona/transport/session…）不得
   `import '../nga/…'` 之类——反向依赖（平台 → 核心）同样禁止，平台只准依赖
   `types.ts`、`config.ts` 类型与 `shared/`。
2. **每个平台自带 `register*Tools`**，bootstrap 统一接线（steam/dota/xhh/nga 已对齐；
   bili 无工具只有自检）。平台挂了 = 它自己的工具不可用，聊天/日记/记忆照常。
3. **只同步聊天修订**（比如到 work 分支）：挑 `transport/ session/ persona/ commands/
   middleware/ features/ media/` 下的提交即可，平台目录整个跳过；冲突概率最高的
   共享文件只有 `config.ts`（各平台配置段集中、字段互不重叠）和 `bootstrap.ts`
   （接线段分块注释，按块取舍）。

## 一、模块清单

| 模块 | 文件 | 作用 | 合并风险 |
|---|---|---|---|
| Steam 状态 | `src/steam/{settings,bindings,steam-id,steam-api,service,tools,index}.ts` | 查群友在线/在玩什么、好友列表、自助绑定、凭据运行时存储 | 低（上游基本不碰 `src/steam`） |
| Dota 战绩 | `src/dota/{heroes,heroes-data,opendota,service,tools,index}.ts` | 最近战绩、单场详细解析（经济/对位/目标/曲线/团战） | 低 |
| 战绩隔夜播报 | `src/persona/dota-digest.ts` | 凌晨查已绑定群友 → 次日 10-12 点发群活跃气氛（3 天内同类不重复） | **中**（在 `src/persona` 下，上游常改） |
| 群活跃度评分 | `src/features/group-activity.ts` | 按「Dota 相关度」给群打分，决定播报发哪个群 | **中**（`src/features` 上游也动） |
| 会话枚举 | `src/session/session-manager.ts` 的 `listLiveGroups()` | 列出存活群会话，供选群 | **中**（该文件上游常改） |
| 群消息埋点 | `src/transport/inbound.ts` 的 `recordGroupActivity(...)` | 只记聚合指标（时间戳/关键词命中/发言者），不留原文 | **中**（该文件上游常改） |
| 配置扩展 | `src/config.ts` 的 `steam`、`dota`、`persona.dotaDigest*`、`persona.dotaKeywords` | 上述功能的开关与参数 | **高**（上游常加字段，同文件必合） |
| 接线 | `src/gateway/bootstrap.ts` | 构造/启动 Steam、Dota、digest、群活跃度 | **中** |
| CLI | `scripts/steam-config.mjs`、`scripts/steam-friends-export.mjs` | 管理 Steam 凭据/主人账号；导出好友对照表 | 低 |
| NGA | `src/nga/nga.ts`（读帖/列版面/**站内搜索**）、`src/nga/nga-capture.ts`（纯 HTTP 扫码登录）、`src/nga/tools.ts`（qq_nga / qq_nga_login + 工具/面板共用的扫码会话表） | 游客态可读帖列版面；登录后可搜全站/版面；登录走手机扫码，不碰密码、不需要浏览器 | 低（**已出 persona**，独立目录上游不碰）。**改它之前先读第五节** |
| 小黑盒只读 | `src/xhh/{sign,client,images,tools,index}.ts` | 搜帖/刷首页/读正文与评论/把图收进表情库；匿名接口，不碰账号 | 低（全新目录，上游不碰） |
| B站自检 | `src/bili/bili-health.ts` | 输出字段自检（字幕 from、pages title…bili 升级改字段时报警）；主体接入走官方 MCP（cordis.patch.yml 的 mcp-bili），不占本插件代码 | 低 |
| ego 可选依赖 | `src/shared/ego-locate.ts` | 定位宿主 `dsh-ego-browser`（surf 深度抓正文用）；缺席不报错，功能降级不消失 | 低 |
| 人格资产 | `persona/rolecard-xiaoyu.md`（角色卡正本，线上 `rolecard-default.md` 是它的软链）、`persona/PERSONA-CHANGELOG.md`（人设变更日志） | 小羽的人设入库；`roleCardPath` 支持绝对/`~/`/相对仓库根三种路径写法 | 低（上游不碰 `persona/`；**并行会话改卡只改这个正本**，改完 5 秒生效不用重启） |
| 安装引导 | `SETUP.md` | 给其他用户/agent 的安装配置说明 | 低 |

## 二、新增配置项（都在 profile 的 `im-qqbot.config` 下）

```yaml
steam:            # apiKey / ownerSteamId 只作首次采纳，真正生效值在 ~/.dsh-qqbot/steam/settings.json
  enabled: true
  apiKey: ''
  ownerSteamId: ''
  friends: {}
  proactiveEnabled: true
dota:
  enabled: true
  includeWinLoss: true
xhh:                 # 小黑盒只读（搜索/首页/读帖/收图；不需要账号与 Cookie）
  enabled: true
  throttleWindowMs: 1800000  # 实测：link/tree 连打 3 次即封，封禁超 1 小时
  throttleMaxCalls: 6
  defaultLimit: 8
  commentLimit: 12
persona:
  dotaDigestEnabled: true
  dotaDigestGroupId: ''
  dotaDigestQueryHours: [3, 7]
  dotaDigestDeliverHours: [10, 12]
  dotaDigestRecentHours: 24
  dotaDigestMaxItems: 2
  dotaDigestMaxPerDay: 1
  dotaKeywords: []      # 空 = 内置默认（含「打刀」）
```

## 三、合并上游时的处理顺序

1. `git fetch origin && git merge origin/main`（在 `work` 分支上）。
2. 先解 **`src/config.ts`**：通常只是"双方各加字段"，两边都保留即可；不要整文件选边。
3. 再解 **`src/transport/inbound.ts`**：多半是 import 或埋点位置冲突，保留 `recordGroupActivity` 调用。
4. **`src/session/session-manager.ts`**：保住 `listLiveGroups()`。
5. **`lib/**` 的冲突一律不手改**：解决 `src` 后 `npm run build` 覆盖。
6. 收尾必须跑：`npx tsc --noEmit` + `npx vitest run` + `grep -r "<<<<<<<" src lib`。

## 四、可选依赖：`dsh-ego-browser`（agent 浏览器）

**这个包不是硬依赖，是 `peerDependenciesMeta.optional: true`。** 别把它写成 `dependencies`：
写死会让没装它的用户在**安装阶段**就失败，而它只影响两个边缘功能。

| 用到 ego 的地方 | 缺席时的行为 |
|---|---|
| `src/persona/surf.ts` 的 Layer 2（深度抓正文） | `fetchPageText()` 返回空串 → 冲浪走 Layer 0/1/Bing 兜底，**功能不消失，只是见闻变浅** |
| （NGA **不在此列**） | NGA 登录已改为纯 HTTP 扫码，完全不依赖 ego；见 `nga-capture.ts` |

**主体功能完全不依赖它**：聊天、日记、记忆、唤醒、NGA 读帖、Steam、Dota 全都正常。

### 为什么不再硬编码路径

改之前 `surf.ts` 里写死了：

```ts
const EGO_BIN = '/root/.dsh/profiles/web/node_modules/dsh-ego-browser/runtime/ego-linux/bin/ego-browser.mjs';
```

这行在本机跑得通，但它是**部署位置的快照**，不是依赖声明 —— profile 从 `web` 改成
`headless`/`desktop`、换 `DSH_HOME`、或者别人装了这插件，路径就指向不存在的文件，
而且**静默失效**。

实测（2026-11-09）：`dsh-ego-browser` **从本插件包自身 `require.resolve` 不到**
（MODULE_NOT_FOUND），只能从 **profile** 解析 —— 它是跟本插件平级的宿主插件，不是我们的依赖。
所以 `src/persona/ego-locate.ts` 的做法是：

1. 用本仓库既有的 `getProfileDir()` 定位 profile；
2. 从 profile 的 `package.json` 起 `createRequire` → `resolve('dsh-ego-browser/package.json')`
   （走模块解析而不是拼 `node_modules/...`，pnpm 嵌套/软链布局都能过）；
3. 校验 `runtime/ego-linux/bin/ego-browser.mjs` 与 `bin/ego-chrome-wrapper.sh` **都真实存在**
   （只有 package.json 但 runtime 没铺下来 = 半个安装，也算没有）；
4. 拿不到 → 返回 `undefined`，**不抛错**，由调用方降级。

### 排查

```bash
node -e "import('/root/Documents/deepseek-harness/default-workspace/dsh-qqbot/lib/persona/ego-locate.js').then(m=>console.log(m.locateEgo({fresh:true})))"
```

返回 `undefined` 就是没装好；返回对象但路径不存在，说明装的是半成品。

## 五、NGA 接入：九条实测硬约束（每条都对应一次真实翻车）

这一段是**维护 `qq_nga` 之前必读**的。下面每条都是实测踩出来的，
不是推断 —— 不写下来的话，下一次"顺手改一改"会原样再挂一遍。

### 5.1 工具 output schema 是 `additionalProperties: false`，多一个字段整条结果就被扔

**症状**：工具 `execute()` 明明跑成功、拿到真实数据，她那边却只看到
`Error: tool "qq_nga" returned invalid output: "value.keyword" is not a declared property`。

**根因**：`src/persona/tools.ts` 里 `output.schema` 没声明返回的字段 →
宿主 `dsh-tools` 判 `INVALID_TOOL_OUTPUT` → **整个结果被丢弃**。

**我连挂两次**：
1. 加 search 时返回 `keyword`/`scope`，schema 没声明
2. 加版面表时返回 `forums`/`note`，schema 没声明

第二次尤其阴：我用字符串替换插字段，锚点 `subject: { type: 'string' },` 在 schema 里
**出现了两次**，替换命中了 `topics.items.properties` 那个 —— 于是 `keyword`/`scope`/
`forums`/`note` 全被塞进"每条主题的属性"里，顶层照样没声明。
**表面上 schema 里"有这些字"，校验照样失败。**

**规则**：改 output schema 必须配测试（`src/persona/nga-tool-schema.test.ts`）——
它**真的执行 `registerPersonaTools` 拿 schema 对象**，比对"代码 return 的顶层字段" ⊆
"schema 顶层 properties"。**不许用文本解析猜缩进**，我试过，猜错了还以为对。

### 5.2 NGA 的 charset 会说谎

| 接口 | header 说 | 实际 |
|---|---|---|
| `app_api.php`（读帖/列版面） | UTF-8 | UTF-8 ✓ |
| `nuke.php`（登录/用户） | GBK | GBK ✓ |
| `thread.php`（HTML 版面页） | GBK | GBK ✓ |
| **`thread.php?lite=js`（搜索）** | **UTF-8** | **GBK ✗** |

盲信 header 会把中文解成 `����Ҳ����`，而且**不报错** —— 上层文案匹配静默失败
（踩过：把"还没扫码"误判成"二维码过期"）。

**规则**：`decodeByCharset()` 先按 header 解，**解出乱码就换另一个编码重解**，
取干净的那个。判据是替换符 U+FFFD + 一批 GBK 解 UTF-8 的典型乱码字。

### 5.3 fid 可以是负数

NGA 大量版面 fid 是负的：厨艺 `-608808`、小窗视界 `-8725919`、程序员 `-202020`。
我图省事把 tid 的 `assertPositiveInt` 套在 fid 上，这些版**一个都打不开**。

**规则**：fid 只要求"非零整数"，`0` 才是"没指定"的哨兵。
**两处都要改**：`nga.ts` 的 `assertFid` **和** `tools.ts` 里的分支判断
（我改了一处，另一处漏了，第二次才抓到）。

### 5.4 NGA 没有版面目录接口

`__lib=forum&__act=list` 等实测全是 `未定义服务` / `ACTION NOT FOUND`。
她第一次调 `{"action":"list"}` 想让工具"列出所有版面"，只能拿到一句"需要 fid"就卡住。

**规则**：`list` 缺 fid 时**不报错**，直接返回 `KNOWN_FORUMS` 内置表
（10 个版面，全部用 `thread.php?fid=N` 的页面标题逐个验证过）。

### 5.5 搜索会返回占位帖

搜「手冲咖啡」返回 29 条，大半 subject 是「帖子发布或回复时间超过限制」——
原帖已删/过久，服务端只给个占位标题，点进去打不开。

**规则**：过滤 `帖子发布或回复时间超过限制` / `帖子已被删除` / 空标题 / `tid<=0`。
同样的搜索从 29 条变 11 条，全是真帖子。

### 5.6 引用块的真实格式比想象脏

实测 101 层楼里 `[pid=` 出现 **31 次**，真实形态：

```
[quote][pid=887251660,47873940,1]Reply[/pid] <b>Post by [uid=5528287]大部分网友[/uid]
(2026-11-08 10:23):</b><br/><br/>你醒了？…[/quote]
```

直接剥标签会得到 `> Reply Post by 大部分网友 (…)` —— 混着英文噪音。

**规则**：专门抠出作者 + 时间，只留正文 → `> 大部分网友 (2026-11-08 10:23): 你醒了？…`。
引用后**必须补换行**，否则和被引正文粘成一句，读起来像他自己接了半句。

### 5.7 图片要保留可点开的地址

正文里是 `[img]./mon_201708/29/-x.jpg[/img]`（相对路径，坑）。
早先我整个换成 `[图]`，她只能知道"这里有张图"。

**规则**：用回包里的 **`attachPrefix`**（实测 `https://img.nga.cn/attachments/`）补全，
**不硬编码域名**（`img4` / `attachments` 都见过）。
输出 `[图: 完整URL]`，并去掉 `.medium.jpg` 缩略图后缀。

### 5.8 参考实现（别自己从零试接口）

| 仓库 | 有什么 |
|---|---|
| `lindsaylianxinnnn/dsh-nga-fish` | `plugin/lib/bbcode.js`（BBCode 方言，5.6/5.7 的对照来源）、`http.js`（节流/JSONP 剥离/错误分类）、`smiles.js`（7 组 265 个表情）。**注意它 `inject=['webServer']`，只做侧栏面板，不给 agent 注册工具** |
| `leungjunbob/dsh-nga-sidebar` | **`docs/NGA-PARSING-PITFALLS.md`** —— 20+ 条实测坑，最有价值的文档 |
| `AgMonk/nga-api-doc` | 社区维护的接口契约 |
| `ludoux/ngapost2md` | BBCode 方言与匿名 token 反解算法 |

**核实过的事实**：上面这些插件**都不能替代 `qq_nga`** —— 最完整的 `dsh-nga-fish`
只注册面板不注册工具，且要求手动粘贴 cookie + 重启 DSH；我们的扫码登录和
工具注册都是自己做的。

### 5.9 文档与实测不一致时，以实测为准

`NGA-PARSING-PITFALLS.md` 第 4.2 条说总楼层字段叫 `__ROWS`，
**实测 `app_api.php` 叫 `vrows`**（`vrows: 21, totalPage: 2, perPage: 20`）。
两个都认了，但注释里写清了哪个是真的。

同理第 2.5/2.7 条（`__R`/`__U` 结构）是 `read.php?__output=11` 那条路径的，
我们走 `app_api.php` 用不上 —— 但 `__U` 兜底还是加了，防服务端换回去。

---

## 六、标签

| 标签 | 含义 |
|---|---|
| `extensions-20261101` | 本轮扩展清单与合并上游（20 提交）后的状态 |
| `backup-before-upstream-20261101` | 合并前的安全点 |

## 七、改完要不要重启

原则：**数据即时生效，代码和启动配置才需要重启**。目标是日常调整（加人、改称呼、换词）都不用停 bot。

| 改什么 | 文件 | 生效方式 |
|---|---|---|
| 绑 Steam（加人/解绑/改称呼） | `~/.dsh-qqbot/steam/bindings.json` | **立即**（按 mtime 热重读） |
| Steam Key / 主人账号 | `~/.dsh-qqbot/steam/settings.json` | **立即** |
| 她的名字、关键词、群友称呼 | `<personaDataDir>/runtime.json` | **立即** |
| 自己的小号/备用号（这些号的群昵称不算"别人"） | 同上，`selfIds` | **立即** |
| 她接受的称呼 / 兴趣 / 话痨度 | `<personaDataDir>/self.json` | **立即** |
| 群友昵称记忆 | `<personaDataDir>/memory/people.json` | **立即**（30s 缓存） |
| profile 里其它配置（时段、概率、开关） | `~/.dsh/profiles/web/cordis.patch.yml` | 重启 |
| 插件代码 | `src/` + `lib/` | 重启 |

`<personaDataDir>` 一般是 `~/.dsh-qqbot/persona/app-<appId>/`。

### runtime.json 怎么用

改 profile 要重启，但「她叫什么」「群里都有谁」「哪些词该接」这三样变得最勤，所以单独放到数据目录：

```json
{
  "names": ["小深", "阿深"],
  "keywords": ["打刀", "开黑"],
  "otherNames": ["刘宗锴"],
  "selfIds": ["DAE485A31F332848D7D9C17CC0999941"]
}
```

语义是**追加**：profile 里那份是基线，这里只往上加，两边不用惦记对方。
写坏了会降级为空并记一条 warn，不会让她变哑巴。

`selfIds` 是**自己人的 openid**（小号、备用号）。为什么需要它：QQ 里同一个人的
群成员 openid 和私聊 openid 是两个值，所以主人换小号在群里说话，他的群昵称
（people.json 里那条）会被当成"别人的名字"，于是"你觉得我开小号打得怎么样"
这种本该接的话被压掉（knownNames 判成"在叫别人"）。把那个号的 openid 填进来就排除掉。
当前说话人自己已由代码自动排除，不用登记；这里登记的是**不在场时**也要认的号。

改完不用做任何事，下一轮对话就按新的来。想加个人：

```bash
node -e "const p='<personaDataDir>/runtime.json';const fs=require('fs');const j=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,'utf8')):{};j.otherNames=[...new Set([...(j.otherNames||[]),'某某'])];fs.writeFileSync(p,JSON.stringify(j,null,2))"
```

### 为什么代码改不了

插件没有加载器级的热重载（`fs.watch` + 重新 `import`），改 `lib/*.js` 只能重启宿主。
真要频繁改代码，就在开发时用 `dsh web` 前台跑，改完手动重启那一个进程，不影响 DSH NEXT。
