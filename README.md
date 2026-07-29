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

## 首次登录（cookies-only storageState）

与 notion-auto Dashboard 相同：只存 **一个小 JSON**（cookies），不拷 200MB+ Chromium profile。

```bash
# 网页登录，账号名随意（多账号各登一次）
PLAYWRIGHT_HEADLESS=false npm run worker:login -- --account=mark
# → 生成 auth/mark.json（通常几十 KB）

# 用已有 cookies 打开浏览器，人工操作 Notion；终端按 Enter / Ctrl+C 关闭
PLAYWRIGHT_HEADLESS=false npm run worker:open -- --account=mark

# 若已有旧 profile，可免重新登录导出：
NOTION_PROFILE_DIR=/path/to/profiles/outreach-worker \
  npm run worker:export-auth -- --account=mark
```

## 同机多账号（推荐批量吞吐）

**模型：`WORKER_ACCOUNTS` 有几个名字，就起几个独立进程（N 无代码上限）。**  
每个账号：`auth/<name>.json` + 独立 `TMPDIR` / `artifacts` / `log`；**共享 `./data` 锁**，避免双跑同一 Session。

```bash
# 1) 每个 Notion 登录各 login 一次
PLAYWRIGHT_HEADLESS=false npm run worker:login -- --account=mark
PLAYWRIGHT_HEADLESS=false npm run worker:login -- --account=hayes

# 2) .env
WORKER_ACCOUNTS=mark,hayes
OUTREACH_BATCH_LIMIT=10
# WORKER_STAGGER_SEC=8   # 相邻进程启动间隔（秒）

# 3) 一键启停（仅 outreach 队列；mailbox 建议单账号）
npm run workers:start
npm run workers:status
tail -f log/worker-*.log
npm run workers:stop
```

资源提示：每多一个账号大约多一个 Chromium；机器吃紧时先减少 `WORKER_ACCOUNTS` 数量。

### 多账号稳定性验收（摘要）

| 项 | 成功标准 |
|----|----------|
| T1 启停 | 列表内全部 PID alive ≥10min；tmp/artifacts/log 按账号隔离 |
| T2 无双跑 | 同一 Session 同时只被一个 worker Claim/执行 |
| T3 崩溃 | kill 一个进程后最多 1 条短暂 Claimed，可 reclaim/heal |
| T4 隔离 | 一账号限流/失败，其它账号进程仍运行 |
| T5 停止 | `workers:stop` 后无残留 worker；无活进程持锁 |
| 总览 | 配置驱动 N 进程；联合跑 2h 或消化大批 due，无 Claimed/Error 失控堆积 |

详细步骤见仓库计划文档 *Multi-account local workers*。

## 单账号运行

```bash
# .env: NOTION_ACCOUNT=mark  WORKER_ID=worker-mark
npm run worker:diagnose

npm run worker:once          # 两个队列一轮
npm run worker:outreach      # 仅 Outreach
npm run worker:mailbox       # 仅 Mailbox
npm run worker               # 持续轮询
```

## Docker / Compose

宿主机多账号优先用 `npm run workers:start`（任意 N）。

Compose 示例：

```bash
# 单 worker
docker compose --profile single up -d --build

# 双 worker 示例（需 auth/<acct2>.json；再加账号请复制 service，勿 scale）
NOTION_ACCOUNT=mark NOTION_ACCOUNT_B=hayes docker compose --profile multi up -d --build
```

共同挂载 `./data`、`./auth`；各容器独立 `TMPDIR` / `ARTIFACT_DIR` / `WORKER_ID`。

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

## 调度字段所有权（多 worker 必读）

`Next Wake At` **只属于 Controller Prompt**，它镜像 `Outreach State JSON.model_state.next_touch_at`（下一次可外发的计划时间）。

Worker 只读它、不写它。技术重试的退避时间放在 `data/retry-cooldowns/`（所有 worker 共享），不再借用 `Next Wake At`。

> 2026-07-29 事故：5 账号并发时 `scheduleTechnicalRetry` / `releaseToPendingWithError` 把 `Next Wake At` 覆写成"now+30s"，
> 计划在 8 月 3 日的 M2 被判定为 due，两个客户提前 5 天收到重复邮件。详见 `tests/unit/planDrift.test.ts`。

护栏（任一条不满足就不外发）：

| 层 | 检查 |
|----|------|
| poll 拿锁后 | 重新读行 + `isSchedulerEligible`，不再用快照 claim |
| poll / 提交前 ×2 | `detectPlanDrift`：`next_touch_at` 在未来而 `Next Wake At` 已 due ⇒ 拒发并自愈 |
| Running visibility | `Next Action` 变化或 `Next Wake At` 变未来 ⇒ 判为「Prompt 已推进」→ skip + 回滚状态，不做技术重试 |
| 执行幂等 | Key 含计划触点；`submitted` 标记 90 天有效且不被重启清理 |

排查与修复：

```bash
npm run worker:diagnose -- --drift        # 只读：列出 Next Wake At 与计划不一致的 Session
npm run worker:diagnose -- --heal-drift   # 用 next_touch_at 还原 Next Wake At（置 Sleeping）
npm run worker:diagnose -- --heal         # 上面两者 + Claimed/Error 复位
```

## 关键修复（相对旧版）

1. **Conversation URL**：拒绝 `?t=new` 与裸 Prompt 页；接受 Notion Agent 的 `app.notion.com/p/…?t=<threadId>`。
2. **批量 Session 复用 AI Chat**：成功轮次累计到随机 **15–25** 后 New chat。
3. **懒 Claim + 锁续期/看门狗**：避免批预 Claim 孤儿；写回可按 Last Control JSON 调和。
4. **多账号一键启停**：`WORKER_ACCOUNTS` → N 进程，共享 `./data`。
5. **调度字段所有权**：worker 不再写 `Next Wake At`；due 资格在拿锁后复核；提前外发被 plan-drift 闸门拦住。

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
scripts/           login / open / diagnose / start|stop|status-workers
tests/unit/
auth/              <account>.json（勿提交）
data/              共享 session/execution locks
log/               worker-<account>.log / .pid
```
