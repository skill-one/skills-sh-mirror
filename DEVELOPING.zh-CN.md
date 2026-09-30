# 开发指南

如何运行、校验和扩展爬虫。使用数据:[README.zh-CN.md](README.zh-CN.md) · English: [DEVELOPING.md](DEVELOPING.md)

## 工作原理

`node scraper.mjs [--out data]` 只访问 skills.sh,每轮从零重建全部产物:

1. `GET /api/v1/skills?per_page=500&page=N`(约 17 次请求)—— 排行榜。只保留 GitHub 来源条目,每个 id 规范化为 `${source}/${去斜杠的 slug}`(`lib.mjs` 中的 `canonicalId`——skills.sh 以去斜杠形式作含斜杠 slug 的键);well-known(非 GitHub)来源与上游标记为重复的条目被跳过并计数。
2. `GET /api/v1/skills?view=trending&per_page=200` —— 单次请求拉取 trending 榜单;前 100 个 GitHub 来源 id(按榜单顺序)写入 `trending.json`。
3. `GET /api/v1/skills/curated` —— 官方精选伙伴;`curated.jsonl` 每个 owner 一行,技能条目精简为规范化 id(不做来源过滤)。
4. 写入 `skills.jsonl`({ id, name, installs },按 installs 降序、并列按 id 升序)与 `README.md`——dist 分支的着陆页:文件说明 + 本轮运行统计(耗时与跳过计数),供人阅读。

每个产物先写 `<path>.tmp` 再用 rename(2) 原子换入,崩溃绝不会留下写了一半的文件。索引就是排行榜本身:不抓任何技能内容,上游下架的技能自然离开索引。瞬时故障(429/5xx、网络错误)按退避重试并遵循 `Retry-After`;`4xx` 是确定性的,一律不重试。

## 前置条件

Node >= 24 和一个 Vercel OIDC token(任意 Vercel 项目均可):

```bash
npm i -g vercel
vercel link && vercel env pull   # 将 VERCEL_OIDC_TOKEN 写入 .env.local,约 12 小时有效
```

token 过期后(HTTP 401)重新执行 `vercel env pull` 即可。切勿提交 `.env.local`。

## 验证

| 层 | 回答的问题 | 依赖 | 命令 |
|---|---|---|---|
| 1. 离线测试 | 爬取逻辑是否正确? | 无(mock API) | `npm test` |
| 2. 产物校验器 | 数据集是否完整? | 无(不联网) | `node verify.mjs --out data` |
| 3. 真实 API 运行 | 线上接口行为是否未变? | token | `node scraper.mjs && node verify.mjs` |

`verify.mjs` 是数据集被信任或发布前的门禁:每行可解析且恰好只有 `id` + `installs`(id 为规范化的 `owner/repo/slug`,installs 非负)、id 唯一且排序确定(installs 降序、并列按 id 升序)、`trending.json` 是 id 数组、`curated.jsonl` 是格式正确的 owner 行、`README.md` 存在、无 `.tmp` 残留。

## CI

- **`ci.yml`**(push / PR):层 1,跑在 Node 24 上——无需 secrets,fork 的 PR 也能运行。
- **`fetch-skills.yml`**:每日 18:00 UTC 金丝雀 + 发布器(`gh workflow run fetch-skills.yml` 可手动触发)。用长效 `VERCEL_TOKEN` 现场换取新 OIDC token(所需 secrets:`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`)→ `node scraper.mjs` → `node verify.mjs` → `node publish.mjs`,后者将 `dist` 分支强制推送为恰为发布清单的单个无父提交,重指 `dist-<日期>` 标签,并裁剪超出 `--window`(默认 30)的旧标签。若已发布的树不恰为发布清单、或标签没有指向它,运行会失败。
