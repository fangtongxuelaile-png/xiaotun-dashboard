# 静态数据中台完整部署教程
## GitHub Pages + Supabase + 钉钉通知 + 自动保活

> 适用场景：纯前端单页应用（HTML/CSS/JS），需要持久化登录日志、免费托管、安全推送通知。  
> 目标读者：AI / 开发者，可直接复用本文所有代码片段。

---

## 一、整体架构

```
用户浏览器
    │
    ▼
GitHub Pages（静态托管）          ← 免费，全球 CDN，零服务器
    │  index.html（单文件应用）
    │
    ├──▶ Supabase REST API        ← 免费 PostgreSQL，写登录日志/操作日志/数据同步
    │       login_history 表
    │       operation_history 表
    │       data_uploads 表
    │
    └──▶ Supabase Edge Function   ← 安全代理层，藏 Webhook 密钥
            dingtalk-notify
                │
                ▼
            钉钉自定义机器人       ← 有人登录 → 立刻推送消息给老板
```

**核心原则**：前端代码永远是公开的（GitHub 仓库是公开的），所有密钥/Token 必须放在服务端。

---

## 二、GitHub Pages 部署

### 2.1 创建仓库并推送

```bash
# 本地项目目录
git init
git add index.html         # 主文件
git add index2_spirit.html # 旧入口（现在是重定向页，见2.3）
git commit -m "initial deploy"

git remote add origin https://github.com/你的用户名/仓库名.git
git push -u origin main
```

### 2.2 开启 GitHub Pages

1. 仓库 → **Settings** → **Pages**
2. Source 选 **Deploy from a branch**
3. Branch 选 `main` / `(root)`
4. 保存 → 等 1~2 分钟 → 访问 `https://用户名.github.io/仓库名/`

### 2.3 单入口原则（重要）

多个 HTML 文件容易导致"改了 A，部署的是 B"的隐性 bug。  
解决方案：**只维护 `index.html`，其余文件改为 0 秒跳转页**。

```html
<!-- index2_spirit.html 的全部内容 -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0; url=index.html">
  <title>正在跳转...</title>
</head>
<body>
  <script>window.location.replace('index.html');</script>
</body>
</html>
```

### 2.4 日常推送工作流

```bash
# 改完 index.html 后
git add index.html
git commit -m "feat: 描述本次改动"
git push
# GitHub Pages 自动 rebuild，约 30 秒生效
```

---

## 三、Supabase 数据库配置

### 3.1 建表 SQL

在 Supabase 控制台 → SQL Editor 执行：

```sql
-- 登录日志表
CREATE TABLE login_history (
  id          BIGSERIAL PRIMARY KEY,
  username    TEXT NOT NULL,
  ip_address  TEXT,
  user_agent  TEXT,
  status      TEXT DEFAULT 'success',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 操作日志表
CREATE TABLE operation_history (
  id         BIGSERIAL PRIMARY KEY,
  username   TEXT,
  action     TEXT,
  detail     TEXT,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 云端数据同步表（存 JSON 快照）
CREATE TABLE data_uploads (
  id          BIGSERIAL PRIMARY KEY,
  tab         TEXT,              -- 'bili' / 'ad' / 'content'
  uploader    TEXT,
  filename    TEXT,
  row_count   INT,
  data        JSONB,
  uploaded_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3.2 Row Level Security（RLS）配置

```sql
-- 开启 RLS（阻止未授权读取）
ALTER TABLE login_history     ENABLE ROW LEVEL SECURITY;
ALTER TABLE operation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_uploads      ENABLE ROW LEVEL SECURITY;

-- 只允许「写入」，不允许前端读登录历史（防止数据泄露）
CREATE POLICY "allow_insert_login" ON login_history
  FOR INSERT WITH CHECK (true);

CREATE POLICY "allow_insert_op" ON operation_history
  FOR INSERT WITH CHECK (true);

-- 数据同步表允许读写（前端需要拉取最新数据）
CREATE POLICY "allow_all_uploads" ON data_uploads
  FOR ALL USING (true) WITH CHECK (true);
```

### 3.3 前端调用方式

```javascript
const SUPA_URL = 'https://你的项目ID.supabase.co';
const SUPA_KEY = 'sb_publishable_你的anon公钥';  // anon key，可以公开

// 写入一条记录
function _supaInsert(table, data) {
  return fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPA_KEY,
      'Authorization': 'Bearer ' + SUPA_KEY,
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify(data)
  }).then(res => {
    if (!res.ok) return res.text().then(t => { throw new Error('HTTP ' + res.status + ' · ' + t.slice(0, 160)); });
    return res;
  });
}

// 登录时记录
function logLogin(username, status) {
  // 先异步获取 IP
  fetch('https://api.ipify.org?format=json')
    .then(r => r.json())
    .then(d => {
      _supaInsert('login_history', {
        username,
        ip_address: d.ip,
        user_agent: navigator.userAgent.substring(0, 200),
        status: status || 'success'
      }).catch(e => console.warn('登录日志写入失败:', e.message));
    });
}
```

---

## 四、登录记录查看

### 4.1 在 Supabase 控制台查看

1. Supabase 控制台 → **Table Editor** → 选 `login_history`
2. 可按时间倒序排列，看到每次登录的账号、IP、设备、时间

### 4.2 在应用内查看（前端代码）

```javascript
// 查询最近 50 条登录记录（需要对应 RLS 策略允许 SELECT）
async function fetchLoginHistory() {
  const res = await fetch(
    `${SUPA_URL}/rest/v1/login_history?order=created_at.desc&limit=50`,
    { headers: { 'apikey': SUPA_KEY, 'Authorization': 'Bearer ' + SUPA_KEY } }
  );
  const rows = await res.json();
  // rows 是数组：[{username, ip_address, user_agent, status, created_at}, ...]
  return rows;
}
```

> ⚠️ 如果 RLS 只允许 INSERT 不允许 SELECT（见 3.2），前端读取会返回空数组。  
> 建议在后台直接看 Supabase 控制台，不在前端暴露历史记录。

---

## 五、钉钉登录通知（安全代理方案）

### 5.1 为什么不能直接在前端调用钉钉 Webhook

- GitHub 仓库是公开的 → `index.html` 全球可见
- 钉钉 Webhook URL 和加签 Secret 一旦写在前端 → 任何人都能冒充机器人发消息
- 正确方案：**前端调 Supabase Edge Function → Edge Function 读服务端环境变量 → 调钉钉**

### 5.2 创建钉钉机器人

1. 钉钉群 → **群设置** → **智能群助手** → **添加机器人** → **自定义**
2. 安全设置选 **「加签」**，复制 `SECxxxx` 密钥
3. 复制 Webhook URL：`https://oapi.dingtalk.com/robot/send?access_token=xxxxx`

### 5.3 Supabase Edge Function 代码

```
项目目录结构：
supabase/
  functions/
    dingtalk-notify/
      index.ts
```

```typescript
// supabase/functions/dingtalk-notify/index.ts
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

// 钉钉加签：HMAC-SHA256(secret, `${timestamp}\n${secret}`) → Base64 → URL编码
async function sign(secret: string, ts: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}\n${secret}`));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return encodeURIComponent(b64);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  // 密钥从服务端环境变量读取，永远不出现在前端代码
  const webhook = Deno.env.get("DING_WEBHOOK");
  const secret  = Deno.env.get("DING_SECRET") || "";

  if (!webhook) {
    return new Response(JSON.stringify({ ok: false, error: "DING_WEBHOOK 未配置" }), {
      status: 500, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  let payload: Record<string, unknown> = {};
  try { payload = await req.json(); } catch { /* 忽略空 body */ }

  const username = String(payload.username ?? "未知");
  const name     = String(payload.name     ?? "");
  const ip       = String(payload.ip       ?? "未知");
  const ua       = String(payload.userAgent ?? "").slice(0, 120);
  const time     = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

  const content =
    `🔐 小豚当家 · 登录成功\n` +
    `账号：${name ? name + "（" + username + "）" : username}\n` +
    `时间：${time}\n` +
    `IP：${ip}\n` +
    `设备：${ua}`;

  let url = webhook;
  if (secret) {
    const ts = Date.now();
    url += `&timestamp=${ts}&sign=${await sign(secret, ts)}`;
  }

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msgtype: "text", text: { content } }),
    });
    const data = await r.json();
    return new Response(JSON.stringify({ ok: data.errcode === 0, ding: data }), {
      headers: { ...CORS, "content-type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 502, headers: { ...CORS, "content-type": "application/json" },
    });
  }
});
```

### 5.4 部署 Edge Function

```bash
# 安装 Supabase CLI（如未安装）
npm install -g supabase

# 登录
supabase login

# 链接到你的项目
supabase link --project-ref 你的项目ID

# 设置服务端环境变量（密钥存在服务器，不进代码）
supabase secrets set DING_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=你的token"
supabase secrets set DING_SECRET="SEC你的加签密钥"

# 部署函数（--no-verify-jwt 允许前端不带 JWT 调用）
supabase functions deploy dingtalk-notify --no-verify-jwt
```

### 5.5 前端调用 Edge Function

```javascript
// 登录成功后调用
async function notifyDingLogin(user) {
  const ip = await fetch('https://api.ipify.org?format=json')
                    .then(r => r.json()).then(d => d.ip).catch(() => '未知');
  fetch('https://你的项目ID.supabase.co/functions/v1/dingtalk-notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: user.username,
      name: user.name,
      ip,
      userAgent: navigator.userAgent
    })
  }).catch(() => {}); // 通知失败不影响登录流程
}
```

---

## 六、GitHub Actions 自动保活（每 5 天）

### 6.1 为什么需要保活

Supabase **免费套餐**规则：项目连续 **7 天无任何 API 请求** → 自动暂停。  
暂停后访问会报错，需要手动到控制台点「恢复」。

解决方案：GitHub Actions 每 5 天自动 ping 一次 Supabase API，保持项目活跃。

### 6.2 Workflow 文件

```
项目目录：
.github/
  workflows/
    keep-supabase-alive.yml
```

```yaml
# .github/workflows/keep-supabase-alive.yml
name: Keep Supabase Alive

on:
  schedule:
    - cron: '0 6 */5 * *'   # 每5天 UTC 06:00 执行
  workflow_dispatch:          # 支持手动触发（GitHub Actions 页面点按钮）

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Ping Supabase
        run: |
          STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
            "https://你的项目ID.supabase.co/rest/v1/login_history?limit=1" \
            -H "apikey: 你的anon公钥" \
            -H "Authorization: Bearer 你的anon公钥")
          echo "Supabase response: $STATUS"
          if [ "$STATUS" = "200" ]; then
            echo "✅ Supabase is alive"
          else
            echo "⚠️ Unexpected status: $STATUS"
          fi
```

> ℹ️ `anon` 公钥写在 workflow 里没问题，它本来就是公开设计的，权限受 RLS 控制。

### 6.3 cron 表达式说明

```
┌─────── 分钟 (0-59)
│  ┌──── 小时 (0-23)，UTC 时间，+8 = 北京时间
│  │  ┌─ 每X天
│  │  │
0  6  */5  *  *
         └── 每月每5天的第1、6、11、16、21、26、31日
```

| 需求 | cron 表达式 |
|------|------------|
| 每5天 | `0 6 */5 * *` |
| 每3天 | `0 6 */3 * *` |
| 每天 | `0 6 * * *` |
| 每周一 | `0 6 * * 1` |

### 6.4 查看执行记录

GitHub 仓库 → **Actions** → 选 `Keep Supabase Alive` → 点任意一次 Run → 查看日志

---

## 七、安全设计全景图

```
┌─────────────────────────────────────┐
│         前端（公开，人人可看）          │
│                                     │
│  ✅ Supabase anon key（公开设计）     │
│  ✅ Supabase 项目 URL                │
│  ❌ 钉钉 Webhook URL  ──────────────►│→ 绝对不能在前端
│  ❌ 钉钉 加签 Secret  ──────────────►│→ 绝对不能在前端
│  ❌ 任何第三方 API Secret             │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│    Supabase Edge Function（服务端）  │
│                                     │
│  通过 `supabase secrets set` 写入：  │
│  DING_WEBHOOK = "https://..."       │
│  DING_SECRET  = "SECxxx"            │
│                                     │
│  代码用 Deno.env.get("DING_WEBHOOK")│
│  读取，绝不输出到响应体               │
└─────────────────────────────────────┘
```

---

## 八、常见问题排查

### Q1：推送后页面没更新
- 等 30 秒再刷新
- 检查 GitHub Actions 有没有 build 失败（仓库 → Actions 页）
- 强制刷新浏览器：Mac `Cmd+Shift+R` / Win `Ctrl+Shift+F5`

### Q2：登录日志写不进去
- 打开浏览器 Console → 看有没有 `HTTP 4xx` 错误
- 检查 RLS 策略是否允许 INSERT
- 检查 `apikey` 和 `Authorization` header 是否正确

### Q3：钉钉收不到消息
- 先在 Edge Function 日志里确认是否调用成功（Supabase 控制台 → Functions → Logs）
- 确认 `DING_WEBHOOK` 和 `DING_SECRET` 是否已通过 `supabase secrets set` 设置
- 钉钉机器人 → 安全设置 → 确认「加签」已开启且密钥一致

### Q4：Supabase 项目被暂停了
- Supabase 控制台 → 找到项目 → 点 **Restore** 按钮
- 然后检查 GitHub Actions 的保活 workflow 是否正常运行

### Q5：Console 报 SyntaxError 导致所有函数都 undefined
- `SyntaxError` 会让整个 `<script>` 块停止解析，后续所有函数全部不存在
- 先看 Console 第一个红色报错，找到行号，修复语法后其余错误自动消失
- 常见原因：`.?` 可选链语法（旧浏览器不支持）、未闭合的字符串/括号

---

## 九、完整文件清单

```
项目根目录/
├── index.html                          # 主应用（所有功能都在这一个文件）
├── index2_spirit.html                  # 旧入口，现在只是跳转到 index.html
├── .github/
│   └── workflows/
│       └── keep-supabase-alive.yml    # 每5天自动 ping Supabase
└── supabase/
    └── functions/
        └── dingtalk-notify/
            └── index.ts               # 钉钉通知安全代理（需 supabase CLI 部署）
```

---

## 十、快速复用清单（给 AI 的操作步骤）

```
□ 1. 创建 GitHub 公开仓库，推送 index.html
□ 2. Settings → Pages → 开启，记录访问 URL
□ 3. 创建 Supabase 项目，执行建表 SQL，配置 RLS
□ 4. 复制 anon key 和项目 URL，写入 index.html 的 SUPA_URL / SUPA_KEY
□ 5. 创建钉钉自定义机器人，开启「加签」，复制 Webhook URL 和 Secret
□ 6. supabase secrets set 写入两个密钥
□ 7. supabase functions deploy dingtalk-notify --no-verify-jwt
□ 8. 创建 .github/workflows/keep-supabase-alive.yml，填入项目 URL 和 anon key
□ 9. 推送所有文件，在 GitHub Actions 手动触发一次保活 workflow 验证
□ 10. 登录应用，检查 Supabase login_history 表和钉钉群消息
```
