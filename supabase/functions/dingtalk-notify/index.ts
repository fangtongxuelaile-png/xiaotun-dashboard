// Supabase Edge Function: dingtalk-notify
// 作用：作为前端 → 钉钉自定义机器人的安全中转代理
// - 解决浏览器 CORS 跨域问题（前端无法直连钉钉）
// - 钉钉 webhook 地址与加签密钥藏在服务端环境变量，不暴露在公开前端
//
// 部署前需在 Supabase 配置两个 secret：
//   DING_WEBHOOK = https://oapi.dingtalk.com/robot/send?access_token=xxxxx
//   DING_SECRET  = SECxxxxx（钉钉机器人「加签」密钥；若未开启加签可留空）
//
// 部署：supabase functions deploy dingtalk-notify --no-verify-jwt

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

// 钉钉加签：sign = urlEncode(base64(HMAC_SHA256(secret, `${ts}\n${secret}`)))
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
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  }

  const webhook = Deno.env.get("DING_WEBHOOK");
  const secret = Deno.env.get("DING_SECRET") || "";
  if (!webhook) {
    return new Response(JSON.stringify({ ok: false, error: "DING_WEBHOOK 未配置" }), {
      status: 500, headers: { ...CORS, "content-type": "application/json" },
    });
  }

  let payload: Record<string, unknown> = {};
  try { payload = await req.json(); } catch { /* 忽略空 body */ }

  const username = String(payload.username ?? "未知");
  const name = String(payload.name ?? "");
  const ip = String(payload.ip ?? "未知");
  const ua = String(payload.userAgent ?? "").slice(0, 120);
  const time = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai", hour12: false,
  });

  const content =
    `🔐 小豚当家 · 登录成功\n` +
    `账号：${name ? name + "（" + username + "）" : username}\n` +
    `时间：${time}\n` +
    `IP：${ip}\n` +
    `设备：${ua}`;

  // 拼接加签参数
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
