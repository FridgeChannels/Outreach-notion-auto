# Outreach Notion Auto

独立的 FC2.0 Follow-up Playwright Worker 项目（与 `notion-auto` 任务链 Dashboard 分离）。

依据文档：[FC2.0 Follow-up｜Playwright 程序开发流程说明](https://app.notion.com/p/FC2-0-Follow-up-Playwright-9efd0969f6f249d1bd1cdd1bef1676f6)

## 职责

两个通用定时队列：

| Queue | 数据源 | Chat 输入 |
|-------|--------|-----------|
| **Outreach Session Worker** | Session DB | Controller Prompt URL + Client URL |
| **Mailbox Scan Worker** | Mailbox Sync State DB | Mailbox Scan Prompt URL + Mailbox State URL |

Playwright **不**实现 Gmail/Outlook API、邮件意图分析、客户匹配或业务路由；只负责锁、状态、长期 Conversation、整段提交、等待完成与写回验证。

## 安装

```bash
cd Outreach-notion-auto
npm install
npx playwright install chromium
cp .env.example .env
# 编辑 .env 填入 NOTION_API_KEY 等
```

## 首次登录

```bash
npm run worker:login
```

在浏览器完成 Notion 登录后，回到终端按 Enter。登录态写入 `NOTION_PROFILE_DIR`。

## 运行

```bash
# 诊断到期 Session / Mailbox
npm run worker:diagnose

# 单次：两个队列
npm run worker:once

# 单次：仅 Outreach / 仅 Mailbox
npm run worker:outreach
npm run worker:mailbox

# 持续轮询（默认 5 分钟）
npm run worker
```

## Docker / Compose

先在宿主机完成 Notion 登录（浏览器需交互），把 profile 放到 `./profiles/outreach-worker`：

```bash
cp .env.example .env   # 填入 NOTION_API_KEY 等
npm install
npx playwright install chromium
# 确保 NOTION_PROFILE_DIR=./profiles/outreach-worker
npm run worker:login
```

若已有登录态（例如 `notion-auto/profiles/outreach-worker`），可复制过来：

```bash
mkdir -p profiles
cp -R /path/to/profiles/outreach-worker ./profiles/
```

构建并后台启动：

```bash
docker compose up -d --build
docker compose logs -f outreach-worker
```

常用命令：

```bash
docker compose ps
docker compose restart outreach-worker
docker compose down
# 单次跑一轮（不改 compose 服务）
docker compose run --rm outreach-worker npx tsx src/cli.ts --once
```

Compose 会挂载 `./profiles`、`./data`、`./artifacts`、`./log`，并强制 `PLAYWRIGHT_HEADLESS=true`、容器内 `NOTION_PROFILE_DIR=/app/profiles/outreach-worker`。

## 调度条件（对齐文档）

**Outreach**

```
Status IN (Pending, Sleeping)
AND Next Action NOT IN (None, Human Review)
AND Next Wake At <= now
```

**Mailbox**

```
Status = Active
AND Next Scan At <= now
```

## 关键修复（相对旧版）

1. **Conversation URL**：拒绝保存 Prompt 页或 `?t=new` 桩 URL；新建 Chat 后等待真实 Chat 路由再写回。
2. **多行输入**：`Shift+Enter` 换行，避免 Notion AI 把 `\n` 当发送。
3. **Next Action 过滤**：调度排除 `None` / `Human Review`。
4. **完成校验**：要求 `Last Control JSON` 已更新；Sleeping/Pending/Closed 等按文档校验。
5. **双队列**：Mailbox Scan Worker 独立锁命名空间。

## 测试

```bash
npm test
```

## 目录

```
src/
  cli.ts
  config.ts
  locks.ts / errors.ts / logging.ts / artifacts.ts
  notion/          Session + Mailbox repositories
  pages/           Notion AI / Login / Workspace
  flows/           processOutreach / processMailbox / poll / validators
scripts/           login / diagnose
tests/unit/
```
