# AI Cost & Abuse Control — 改动说明与设计文档

## 一、整体架构

本系统在 Open SaaS 项目中新增了一套 **AI 成本与滥用控制系统**，对所有 AI 操作（如 `generateGptResponse`）进行全链路防护。架构采用了**洋葱模型**（Onion/Interceptor Pattern），在 AI 调用前后插入多层拦截器，每一层负责一个独立的防护维度。

### 执行顺序

```
请求 → ①幂等性检查 → ②速率限制 → ③配额检查 → ④并发锁 → ⑤执行AI操作 → ⑥记录日志 → 返回结果
                                                                   ↓ 失败时
                                                             ⑦记录失败日志 → 抛出 HttpError
```

**设计原则：** 成本越低的检查越靠前，尽早拒绝非法请求，避免浪费 AI API 调用费用。

---

## 二、新增文件清单

| 文件 | 模块 | 职责 |
|------|------|------|
| `src/ai-cost-control/constants.ts` | 配置 | 所有阈值常量（速率、配额、定价、TTL） |
| `src/ai-cost-control/index.ts` | 编排 | `withAiCostControl()` 编排中间件 |
| `src/ai-cost-control/quotaEnforcer.ts` | 配额 | 每日/每月 token 配额检查 |
| `src/ai-cost-control/rateLimiter.ts` | 限流 | 滑动窗口速率限制 |
| `src/ai-cost-control/concurrencyGuard.ts` | 并发 | 基于数据库的分布式并发锁 |
| `src/ai-cost-control/idempotency.ts` | 幂等 | 幂等键查重与结果缓存 |
| `src/ai-cost-control/usageLogger.ts` | 日志 | 每条 AI 调用记录的持久化 |
| `src/admin/dashboards/ai-usage/ai-usage.wasp.ts` | Wasp 配置 | 注册路由 + Page + Query |
| `src/admin/dashboards/ai-usage/operations.ts` | 后端查询 | `getAiUsageSummary` + `getAiUsageLogs` |
| `src/admin/dashboards/ai-usage/AiUsageDashboardPage.tsx` | 前端页面 | 用量可视化管理面板 |

## 三、修改文件清单

| 文件 | 改动 |
|------|------|
| `schema.prisma` | 新增 `AiUsageLog`、`IdempotencyRecord`、`ConcurrencyLock` 三个数据模型；User 模型新增 `aiUsageLogs` 关联 |
| `main.wasp.ts` | 导入并注册 `aiUsageAdminSpec` |
| `src/demo-ai-app/operations.ts` | `generateGptResponse` 用 `withAiCostControl()` 包裹；输入 schema 新增可选 `idempotencyKey`；返回 token 估算值 |
| `src/admin/layout/Sidebar.tsx` | 导航栏新增 "AI Usage" 菜单项，使用 `ScanEye` 图标 |

---

## 四、各模块详细设计

### 4.1 数据模型（schema.prisma）

#### AiUsageLog —— 调用日志表

每条 AI 操作记录一行，无论成功还是被拒绝。

```prisma
model AiUsageLog {
  id             String   @id @default(uuid())
  createdAt      DateTime @default(now())
  userId         String
  operation      String   // 操作名称，如 "generateGptResponse"
  status         String   // success / denied_rate_limit / denied_quota / denied_duplicate / denied_concurrent / error
  inputTokens    Int      @default(0)
  outputTokens   Int      @default(0)
  costUsd        Float    @default(0)
  durationMs     Int      @default(0)
  idempotencyKey String?  // 幂等键（如果有）
  errorMessage   String?
  ipAddress      String?

  @@index([userId, createdAt])  // 按用户+时间查询优化
  @@index([status])             // 按状态筛选
  @@index([createdAt])          // 按时间排序
}
```

**设计取舍：**
- 为什么用 String 而非 Enum 表示 status？Prisma SQLite 不支持 Enum，String 更灵活，后续可扩展新状态。
- `idempotencyKey` 和 `errorMessage` 设为可选，因为大部分正常请求不需要这些字段。

#### IdempotencyRecord —— 幂等记录表

```prisma
model IdempotencyRecord {
  id        String   @id          // id 本身就是幂等键
  result    String                // JSON 序列化的缓存结果
  createdAt DateTime @default(now())
  expiresAt DateTime              // TTL 过期时间

  @@index([expiresAt])            // 清理过期记录时使用
}
```

**设计取舍：**
- 使用独立表而非在 AiUsageLog 中标记幂等：因为幂等缓存的是完整结果，需要独立存储；且 AiUsageLog 是只追加的审计日志，不应在其中更新缓存结果。
- TTL 设为 24 小时（`IDEMPOTENCY.KEY_TTL_MS`），覆盖绝大多数重试场景。

#### ConcurrencyLock —— 并发锁表

```prisma
model ConcurrencyLock {
  id        String   @id
  userId    String   @unique       // 每人同时只能有一个AI操作
  lockedAt  DateTime @default(now())
  expiresAt DateTime

  @@index([expiresAt])
}
```

**设计取舍：**
- `userId @unique` 保证每人只能有一个活跃的 AI 操作。这是比通用分布式锁更简单的方案，因为我们的粒度就是"每人"。
- 锁带有 TTL，防止进程崩溃导致死锁。
- 加锁前先清理过期锁（`deleteMany where expiresAt < now`）。

---

### 4.2 常量配置（constants.ts）

所有可调参数集中管理：

```ts
export const RATE_LIMIT = {
  FREE_REQUESTS_PER_HOUR: 5,          // 免费用户每小时5次
  SUBSCRIBED_REQUESTS_PER_HOUR: 60,   // 订阅用户每小时60次
  WINDOW_MS: 60 * 60 * 1000,         // 滑动窗口1小时
};

export const QUOTA = {
  FREE_DAILY_TOKENS: 10_000,          // 免费用户每天1万token
  SUBSCRIBED_DAILY_TOKENS: 100_000,   // 订阅用户每天10万token
  FREE_MONTHLY_TOKENS: 100_000,       // 免费用户每月10万token
  SUBSCRIBED_MONTHLY_TOKENS: 2_000_000,
};

export const PRICING = {
  GPT_35_TURBO_INPUT: 0.0015,        // 每1K输入token $0.0015
  GPT_35_TURBO_OUTPUT: 0.002,        // 每1K输出token $0.002
};
```

**设计取舍：**
- 使用 `as const` 确保类型安全和不可变性。
- Token 配额数字基于典型 GPT-3.5-turbo 使用量设定。免费用户可做 ~25 次简单对话/天，付费用户 ~250 次/天。

---

### 4.3 核心里程碑编排（index.ts）

`withAiCostControl()` 是一个高阶函数，接收一个 AI 操作函数，返回被防护层包裹的新函数。

```ts
async function withAiCostControl<T>(
  user: User,
  operationName: string,
  operation: () => Promise<{ result: T; inputTokens: number; outputTokens: number }>,
  options?: {
    idempotencyKey?: string;
    ipAddress?: string;
    skipConcurrencyCheck?: boolean;  // 特殊情况跳过并发检查
  },
): Promise<T>
```

关键逻辑流程：

1. **幂等性检查**（idempotencyKey 存在时）：查表 → 命中则返回缓存结果（不报错！），记录"denied_duplicate"
2. **速率限制**：查滑动窗口请求数 → 超限抛出 429
3. **配额检查**：聚合当日/当月 token 消耗 → 超限抛出 429
4. **并发锁**：获取分布式锁 → 获取失败抛出 429
5. **执行操作**：`try { operation() } catch { ... }`
6. **记录成功日志**：含 token 数、成本、耗时
7. **保存幂等结果**：如果提供了 idempotencyKey
8. **finally 释放锁**

**边界处理：**
- 非 HttpError 的异常（如 OpenAI API 超时）也会被捕获并记录到 AiUsageLog，便于事后排查。
- idempotencyKey 重复请求不抛错，而是透明返回缓存结果。这意味着前端可以安全地重试。
- 并发锁的释放放在 `finally` 中，确保无论成功/失败都会释放。

---

### 4.4 速率限制器（rateLimiter.ts）

实现**滑动窗口算法**，查询过去 1 小时内成功调用次数。

```ts
export async function checkRateLimit(user: User): Promise<RateLimitResult> {
  const windowStart = new Date(now.getTime() - RATE_LIMIT.WINDOW_MS);
  const count = await prisma.aiUsageLog.count({
    where: {
      userId: user.id,
      operation: "generateGptResponse",
      status: "success",
      createdAt: { gte: windowStart },
    },
  });
  // 判断是否超限
}
```

**设计取舍：**
- 为什么不用 Redis？项目使用 SQLite，无 Redis 基础设施。SQLite 查询在单用户低并发场景下完全够用。
- 滑动窗口 vs 固定窗口：滑动窗口避免了"最后一秒突发大量请求"的问题，但代价是每次都需要数据库查询。对于每小时 5-60 次请求的场景，这个代价可忽略。
- 只统计 `status: "success"` 的请求：被拒绝的请求不计入速率限制，防止用户"用完所有重试次数"。

---

### 4.5 配额执行器（quotaEnforcer.ts）

聚合 `AiUsageLog` 中当日/当月成功调用的 token 消耗，与配额阈值比较。

```ts
const dailyAgg = await prisma.aiUsageLog.aggregate({
  _sum: { inputTokens: true, outputTokens: true },
  where: {
    userId: user.id,
    status: "success",
    createdAt: { gte: startOfDay },
  },
});
```

**设计取舍：**
- 通过数据库聚合查询而非计数器：确保数据一致性，没有缓存过期问题。代价是每次 AI 调用前都需要一次聚合查询。
- 同时检查日配额和月配额：防止用户在某一天用完所有月度配额。
- 返回 `remainingDailyTokens` 等信息，前端可展示给用户。

---

### 4.6 并发守卫（concurrencyGuard.ts）

基于 SQLite 表的分布式锁，利用 `userId` 的唯一约束实现排他性。

**加锁逻辑：**
```ts
// 先清理过期锁
await prisma.concurrencyLock.deleteMany({ where: { expiresAt: { lt: now } } });
// 尝试插入锁记录
await prisma.concurrencyLock.create({ data: { id, userId, lockedAt, expiresAt } });
// 唯一约束冲突 → 获取锁失败
```

**设计取舍：**
- 数据库锁 vs 内存锁：内存锁（如 Map<userId, Promise>）在单进程场景更高效。但 Wasp 架构下 server 可能多实例运行，数据库锁是唯一正确的方式。
- 锁 TTL 设为 30 秒：GPT 调用通常在 5-15 秒内完成，30 秒为异常情况留出缓冲。
- 加锁前清理过期锁，防止过期锁堆积阻碍用户后续请求。
- `releaseConcurrencyLock` 中的 catch 静默处理锁已过期被删除的情况。

---

### 4.7 幂等性（idempotency.ts）

通过 idempotencyKey 实现去重。客户端在调用 AI 操作时传入唯一键，服务端缓存首次成功结果，重复请求直接返回缓存。

```ts
export async function checkIdempotency<T>(key: string) {
  const existing = await prisma.idempotencyRecord.findUnique({ where: { id: key } });
  if (existing) return { isDuplicate: true, cachedResult: JSON.parse(existing.result) };
  return { isDuplicate: false };
}
```

**边界处理：**
- 幂等键的生成责任在前端/调用方。推荐的生成方式：`SHA256(userId + ":" + requestBody + ":" + date)`。
- 24 小时 TTL 覆盖大部分业务场景，过期后的重复请求会正常执行。
- JSON 序列化/反序列化结果：支持任意类型 T 的缓存。

---

### 4.8 用量日志（usageLogger.ts）

记录所有 AI 操作流水。

```ts
export async function logAiUsage(input: UsageLogInput) {
  await prisma.aiUsageLog.create({ data: { ...input } });
}
```

**成本估算：**
```ts
export function estimateCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1000) * 0.0015;
  const outputCost = (outputTokens / 1000) * 0.002;
  return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000;
}
```

**边界处理：**
- Token 数为估算值。在 `demo-ai-app/operations.ts` 中，通过请求/响应文本长度估算（~4 字符/token），实际生产应使用 OpenAI 返回的 `usage` 字段。
- 成本精度到微美元（6位小数），适合统计微小费用。

---

### 4.9 与管理后台集成

#### 后端查询（operations.ts）

- `getAiUsageSummary`：聚合查询，返回总请求数、成功率、总成本、总 token、唯一用户数
- `getAiUsageLogs`：分页查询，支持按 status 筛选，关联 User 表显示邮箱
- 两者均需要 `isAdmin` 权限检查

#### 前端页面（AiUsageDashboardPage.tsx）

- **顶部卡片**：总请求数、成功率、总成本、被拒绝数
- **筛选器**：按状态（Success/Rate Limited/Quota Exceeded/Error 等）筛选
- **表格**：时间、用户邮箱、操作名、状态徽章、Token 数、成本、耗时
- **分页**：前后翻页

**设计取舍：**
- 使用 `<table>` 而非更复杂的组件库：ShadCN 的 Table 组件尚未安装，原生 HTML table 简洁够用。
- `log` 类型使用了 `any`：因为 Wasp 生成的上下游类型尚未完全同步。生产应使用 `wasp/entities` 中的生成类型。

---

## 五、改动集成

### 5.1 demo-ai-app 集成（operations.ts）

在 `generateGptResponse` 中，用 `withAiCostControl` 包裹核心逻辑：

```ts
return withAiCostControl<GeneratedSchedule>(
  currentUser as unknown as User,
  "generateGptResponse",
  async () => {
    // ... 原有的 AI 调用逻辑 ...
    return { result: generatedSchedule, inputTokens, outputTokens };
  },
  { idempotencyKey, ipAddress: (context as any).request?.ip },
);
```

同时输入 schema 新增了可选的 `idempotencyKey` 字段，前端可以根据需要传入。

### 5.2 路由注册（main.wasp.ts + ai-usage.wasp.ts）

```
AdminAiUsageRoute → /admin/ai-usage → AiUsageDashboardPage（需认证）
↓
getAiUsageSummary   (query, 读取 AiUsageLog + User)
getAiUsageLogs      (query, 读取 AiUsageLog + User)
```

---

## 六、测试方式

1. **启动项目**：`cd template/app && npx @wasp.sh/wasp-cli start`
2. **注册并登录**：访问 `http://localhost:3001/signup`，创建账号
3. **访问 Demo App**：到 `/demo-app` 创建一些 Task，点击 "Generate Schedule"
   - 默认 `OPENAI_API_KEY` 是 dummy 值，AI 调用会失败，但 AiUsageLog 中会记录 "error" 状态
4. **查看管理后台**：登录后访问 `/admin/ai-usage`（需要在 `.env.server` 中配置 `ADMIN_EMAILS` 包含你的邮箱）
5. **触发限流**：免费用户每小时 5 次请求，超过后返回 429
6. **触发配额限制**：多次调用累积 token 消耗，超过 10,000 日配额后返回 429
7. **幂等性测试**：传入相同的 `idempotencyKey`，第二次调用直接返回缓存结果

## 七、后续优化方向

1. **真实 Token 计数**：使用 OpenAI 返回的 `usage.prompt_tokens` 和 `usage.completion_tokens`
2. **用户可见的配额提示**：前端捕获 429 错误，展示用户友好的提示和剩余配额
3. **定时清理任务**：用 Wasp Jobs 定期清理过期的 IdempotencyRecord 和 ConcurrencyLock
4. **配额重置 CDN**：计数器缓存在内存/Redis 中减少数据库查询
5. **更细粒度的计费**：按模型（GPT-4 vs GPT-3.5）区分定价
6. **告警通知**：当某用户日消耗超过阈值时发送通知
7. **审计导出**：支持 CSV 导出 AI 调用日志
