# skills.sh 数据镜像

[skills.sh](https://www.skills.sh) 全站 GitHub 来源技能的每日快照——以可查询的排行榜索引呈现。所有数据都来自 skills.sh 的 API:不抓技能内容,不调 GitHub 接口。索引行的 id 就是技能在上游的地址,因此无需镜像其他东西。

English: [README.md](README.md) · 开发指南:[DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)

## 数据

```
skills.jsonl    每个技能一行 { id, installs },按 installs 降序 —— 查询/筛选/排行在这里
trending.json   trending 榜单中前 100 个 GitHub 来源 id,按榜单顺序
curated.jsonl   官方精选技能,每个 owner 一行
README.md       dist 分支的着陆页 —— 文件说明 + 最近一次运行的统计
```

```json
{"id": "vercel-labs/skills/find-skills", "installs": 3263512}
```

- `id` —— 规范化的 `{owner}/{repo}/{slug}`:它同时就是安装参数(`npx skills add <id>`),前两段即托管该技能的 GitHub 仓库,技能页面在 `https://skills.sh/<id>`。
- `installs` —— 该技能在 skills.sh 上的安装量。

所有产物都用同一规范化 id 作键,`trending.json` 与 `curated.jsonl` 可直接 join 回 `skills.jsonl`(curated 不做来源过滤,同一技能可出现在多个 owner 名下)。上游标记为重复的条目会被跳过——每个去重技能一行;下架的技能在下一轮运行中自然离开索引。`verify.mjs` 是每次发布前的门禁。

## 获取数据

由工作流每日发布到 [`dist` 分支](../../tree/dist)——分支顶端始终是一份完整快照(单个无父提交,每轮替换);更早的日期保存在 `dist-<日期>` 标签里(最新 30 个,标签名不含 `/`,可在 raw URL 中解析)。

```bash
BASE=https://raw.githubusercontent.com/skill-one/skills-sh-mirror
curl -sO $BASE/dist/skills.jsonl                                             # 最新快照
curl -s $BASE/dist/skills.jsonl | jq -r 'select(.installs > 100000) | .id'   # 或直接在线查询
curl -sO $BASE/dist-2026-09-11/skills.jsonl                                  # 钉住某天
```

`dist` 上 raw 的约 5 分钟分支缓存就是最坏延迟(jsDelivr 为 12 小时);`dist-<日期>` 标签一经发布不再变化,可放心按标签缓存。

```bash
git clone --depth 1 -b dist https://github.com/skill-one/skills-sh-mirror.git   # 整份快照
git ls-remote --tags --refs https://github.com/skill-one/skills-sh-mirror.git 'dist-*'   # 列出日期
```

快照由 GitHub Actions 发布——`gh workflow run fetch-skills.yml` 可立即触发。自己生成:`node scraper.mjs` —— 见 [DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)。
