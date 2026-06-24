// Supabase Edge Function: qianchuan-proxy
// 作用：前端 → 巨量千川 API 的安全中转代理
// - token 持久化到 Supabase 数据库，不再丢内存
// - /callback 自动处理 OAuth 回调，换取 token
// - access_token 24h 过期 → 自动用 refresh_token 续期

// @ts-ignore
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const QIANCHUAN_API = "https://ad.oceanengine.com/open_api";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

// ──── Supabase 客户端 ────
function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

// ──── 数据库 token 读写 ────
interface TokenRow {
  id: number;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null; // ISO 8601
}

async function loadTokens(): Promise<TokenRow | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("qianchuan_tokens")
    .select("*")
    .eq("id", 1)
    .single();
  return data;
}

async function saveTokens(tokens: { access_token: string; refresh_token: string | null; expires_at: string }) {
  const supabase = getSupabase();
  await supabase
    .from("qianchuan_tokens")
    .update({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
}

// ──── OAuth 工具 ────

/** 用 auth_code 换取 access_token + refresh_token，写入数据库 */
async function exchangeAuthCode(authCode: string) {
  const appId = Deno.env.get("QIANCHUAN_APP_ID")!;
  const secret = Deno.env.get("QIANCHUAN_SECRET")!;

  const resp = await fetch(`${QIANCHUAN_API}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: Number(appId),
      secret,
      grant_type: "auth_code",
      auth_code: authCode,
    }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`auth_code 换 token 失败 [${data.code}]: ${data.message}`);
  }

  const expiresMs = (data.data.expires_in || 86400) * 1000;
  const expiresAt = new Date(Date.now() + expiresMs).toISOString();

  await saveTokens({
    access_token: data.data.access_token,
    refresh_token: data.data.refresh_token || null,
    expires_at: expiresAt,
  });

  console.log("✅ Token 获取成功并存入数据库 (有效期 " + (data.data.expires_in || 86400) + " 秒)");
  return data.data;
}

/** 用 refresh_token 刷新 access_token，更新数据库 */
async function refreshAccessToken(): Promise<string> {
  const appId = Deno.env.get("QIANCHUAN_APP_ID")!;
  const secret = Deno.env.get("QIANCHUAN_SECRET")!;

  const tokens = await loadTokens();
  if (!tokens?.refresh_token) {
    throw new Error("无 refresh_token，需要重新授权获取 auth_code");
  }

  const resp = await fetch(`${QIANCHUAN_API}/oauth2/refresh_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: Number(appId),
      secret,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    // refresh_token 也失效了
    await saveTokens({
      access_token: "",
      refresh_token: null,
      expires_at: new Date(0).toISOString(),
    });
    throw new Error(`refresh_token 失效 [${data.code}]: ${data.message}，需重新授权`);
  }

  const expiresMs = (data.data.expires_in || 86400) * 1000;
  const expiresAt = new Date(Date.now() + expiresMs).toISOString();

  await saveTokens({
    access_token: data.data.access_token,
    refresh_token: data.data.refresh_token || tokens.refresh_token,
    expires_at: expiresAt,
  });

  console.log("🔄 Token 已刷新并更新数据库");
  return data.data.access_token;
}

/** 从数据库读取有效的 access_token（自动续期） */
async function getValidAccessToken(): Promise<string> {
  const tokens = await loadTokens();
  if (!tokens?.access_token) {
    throw new Error("未授权。请先访问 /auth 获取授权链接");
  }

  // 提前 60s 过期则刷新
  const expiresAt = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
  if (Date.now() < expiresAt - 60_000) {
    return tokens.access_token;
  }

  if (tokens.refresh_token) {
    return await refreshAccessToken();
  }

  throw new Error("Token 已过期且无 refresh_token，需重新授权");
}

// ──── API 调用 ────

function toQueryParam(v: unknown): string {
  if (Array.isArray(v) || (typeof v === "object" && v !== null)) {
    return JSON.stringify(v);
  }
  return String(v);
}

async function callQianchuan(path: string, params: Record<string, unknown>) {
  const token = await getValidAccessToken();
  const url = new URL(`${QIANCHUAN_API}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, toQueryParam(v));
  });

  const resp = await fetch(url.toString(), {
    headers: { "Access-Token": token },
  });
  const data = await resp.json();

  if (data.code === 40110 || data.code === 40100) {
    const newToken = await refreshAccessToken();
    const retryUrl = new URL(`${QIANCHUAN_API}${path}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) retryUrl.searchParams.set(k, toQueryParam(v));
    });
    const retryResp = await fetch(retryUrl.toString(), {
      headers: { "Access-Token": newToken },
    });
    return await retryResp.json();
  }
  return data;
}

// v3 自定义报表 API（不同域名）
async function callCustomReport(params: Record<string, unknown>) {
  const token = await getValidAccessToken();
  const url = new URL("https://api.oceanengine.com/open_api/v3.0/report/custom/get/");
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, toQueryParam(v));
  });

  const resp = await fetch(url.toString(), {
    headers: { "Access-Token": token },
  });
  const data = await resp.json();

  if (data.code === 40110 || data.code === 40100) {
    const newToken = await refreshAccessToken();
    const retryUrl = new URL("https://api.oceanengine.com/open_api/v3.0/report/custom/get/");
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) retryUrl.searchParams.set(k, toQueryParam(v));
    });
    const retryResp = await fetch(retryUrl.toString(), {
      headers: { "Access-Token": newToken },
    });
    return await retryResp.json();
  }
  return data;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ──── 主入口 ────

serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/qianchuan-proxy/, "").replace(/\/$/, "") || "/";

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  // ── GET /metrics ── 查询 BASIC_DATA 可用指标和维度 ──
  if (req.method === "GET" && path === "/metrics") {
    const advertiserId = url.searchParams.get("advertiser_id");
    const dataTopic = url.searchParams.get("data_topic") || "BASIC_DATA";
    if (!advertiserId) {
      return new Response(JSON.stringify({ ok: false, error: "缺少 advertiser_id" }), {
        status: 400, headers: { ...CORS, "content-type": "application/json" },
      });
    }
    try {
      const token = await getValidAccessToken();
      const metricsUrl = new URL("https://api.oceanengine.com/open_api/v3.0/report/custom/config/get/");
      metricsUrl.searchParams.set("advertiser_id", advertiserId);
      metricsUrl.searchParams.set("data_topics", JSON.stringify([dataTopic]));
      const resp = await fetch(metricsUrl.toString(), { headers: { "Access-Token": token } });
      const data = await resp.json();
      return new Response(JSON.stringify({ ok: true, data }), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), {
        status: 500, headers: { ...CORS, "content-type": "application/json" },
      });
    }
  }

  // ── GET /auth ── 返回授权链接 ──
  if (req.method === "GET" && path === "/auth") {
    const redirectUri = "https://nbfiltgqklzdfaibyeka.supabase.co/functions/v1/qianchuan-proxy/callback";
    const authUrl = `https://ad.oceanengine.com/openapi/audit/oauth.html?app_id=${Deno.env.get("QIANCHUAN_APP_ID")}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    return new Response(
      JSON.stringify({ ok: true, auth_url: authUrl }),
      { headers: { ...CORS, "content-type": "application/json" } },
    );
  }

  // ── GET /callback ── OAuth 回调，自动换 token 存入数据库 ──
  if (req.method === "GET" && path === "/callback") {
    const authCode = url.searchParams.get("auth_code");
    if (!authCode) {
      return new Response(
        "<h1>❌ 授权失败</h1><p>缺少 auth_code</p>",
        { status: 400, headers: { ...CORS, "content-type": "text/html; charset=utf-8" } },
      );
    }
    try {
      const tokenData = await exchangeAuthCode(authCode);
      return new Response(
        `<h1>✅ 授权成功！</h1><p>广告主 ID: ${Deno.env.get("QIANCHUAN_ADVERTISER_ID") || "未设置"}</p><p>Token 有效期: ${(tokenData.expires_in / 3600).toFixed(1)} 小时</p><p>refresh_token: ${tokenData.refresh_token ? "已获取" : "无"}</p><p style="color:green;font-weight:bold">📦 Token 已存入数据库，持久有效！</p>`,
        { headers: { ...CORS, "content-type": "text/html; charset=utf-8" } },
      );
    } catch (e) {
      return new Response(
        `<h1>❌ 授权失败</h1><p>${String(e)}</p>`,
        { status: 500, headers: { ...CORS, "content-type": "text/html; charset=utf-8" } },
      );
    }
  }

  // ── GET /accounts ── 获取已授权账户列表 ──
  if (req.method === "GET" && path === "/accounts") {
    try {
      const token = await getValidAccessToken();
      const resp = await fetch(`${QIANCHUAN_API}/oauth2/application/accounts`, {
        headers: { "Access-Token": token },
      });
      const data = await resp.json();
      return new Response(JSON.stringify({ ok: true, data }), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: String(e) }),
        { status: 500, headers: { ...CORS, "content-type": "application/json" } },
      );
    }
  }

  // ── GET /status ── 检查授权状态 ──
  if (req.method === "GET" && path === "/status") {
    try {
      const tokens = await loadTokens();
      const expiresAt = tokens?.expires_at ? new Date(tokens.expires_at).getTime() : 0;
      const isValid = !!(tokens?.access_token && Date.now() < expiresAt - 60_000);
      return new Response(
        JSON.stringify({
          ok: isValid,
          authenticated: isValid,
          hasRefreshToken: !!tokens?.refresh_token,
          expiresIn: isValid ? Math.round((expiresAt - Date.now()) / 1000) : 0,
        }),
        { headers: { ...CORS, "content-type": "application/json" } },
      );
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: String(e) }),
        { status: 500, headers: { ...CORS, "content-type": "application/json" } },
      );
    }
  }

  // ── POST action ── 数据查询入口 ──
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action || "getReport";

    try {
      const advertiserId = body.advertiser_id || Number(Deno.env.get("QIANCHUAN_ADVERTISER_ID")) || 0;
      if (!advertiserId) {
        return new Response(
          JSON.stringify({ ok: false, error: "缺少 advertiser_id" }),
          { status: 400, headers: { ...CORS, "content-type": "application/json" } },
        );
      }

      if (action === "getAdvertiserInfo") {
        const data = await callQianchuan("/2/advertiser/info/", { advertiser_ids: `[${advertiserId}]` });
        return new Response(JSON.stringify({ ok: true, action, data }), {
          headers: { ...CORS, "content-type": "application/json" },
        });
      }

      const endDate = body.end_date || formatDate(new Date());
      const startDate = body.start_date || formatDate(new Date(Date.now() - 7 * 86400_000));
      const params: Record<string, unknown> = {
        advertiser_id: advertiserId,
        data_topic: body.data_topic || "BASIC_DATA",
        dimensions: body.dimensions || ["stat_time_day"],
        metrics: body.metrics || [
          "cost", "show_cnt", "click_cnt", "ctr",
          "convert_cnt", "conversion_cost", "conversion_rate",
          "deep_convert_cnt", "deep_convert_cost",
        ],
        start_time: startDate + " 00:00:00",
        end_time: endDate + " 23:59:59",
        filters: body.filters || [],
        order_by: [{ field: "stat_time_day", type: "ASC" }],
        page: body.page || 1,
        page_size: body.page_size || 100,
      };

      const reportData = await callCustomReport(params);
      return new Response(JSON.stringify({
        ok: true, action, data: reportData,
        meta: { start_date: startDate, end_date: endDate },
      }), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ ok: false, error: String(e) }),
        { status: 502, headers: { ...CORS, "content-type": "application/json" } },
      );
    }
  }

  return new Response(
    JSON.stringify({ ok: false, error: "不支持的请求" }),
    { status: 405, headers: { ...CORS, "content-type": "application/json" } },
  );
});
