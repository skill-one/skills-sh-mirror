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
- slug(`id` 的最后一段)就是技能在自己的 `SKILL.md` frontmatter 里声明的 `name:` 字段的可寻址形式:转小写、每个空格换成 `-`、删掉 `/`,其余字符(`&`、`.`、`_`、`:` 等)原样保留(如 `agent-development`)。不再单独镜像 name——把空格还原即可从 slug 反推。
- `installs` —— 该技能在 skills.sh 上的安装量。

所有产物都用同一规范化 id 作键,`trending.json` 与 `curated.jsonl` 可直接 join 回 `skills.jsonl`(curated 不做来源过滤,同一技能可出现在多个 owner 名下)。上游标记为重复的条目会被跳过——每个去重技能一行;下架的技能在下一轮运行中自然离开索引。`verify.mjs` 是每次发布前的门禁。

## 获取数据

每日发布到 [`dist` 分支](../../tree/dist)——分支顶端始终是最新的完整快照;更早的日期以 `dist-<日期>` 标签钉住。

```bash
BASE=https://raw.githubusercontent.com/skill-one/skills-sh-mirror
curl -sO $BASE/dist/skills.jsonl               # 最新快照
curl -sO $BASE/dist-2026-09-11/skills.jsonl    # 钉住某天
```

快照如何产出:见 [DEVELOPING.zh-CN.md](DEVELOPING.zh-CN.md)。
