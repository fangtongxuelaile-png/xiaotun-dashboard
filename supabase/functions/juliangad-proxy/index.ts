// Supabase Edge Function: juliangad-proxy
// 巨量广告（效果账户 + 种草通）数据中转代理
// token 存储：qianchuan_tokens id=1
// 与千川代理完全独立，互不影响

// @ts-ignore
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const AD_API = "https://ad.oceanengine.com/open_api";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

// ──── Supabase 客户端 ────
function getSupabase() {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key);
}

// ──── 巨量广告 token（id=1）读写 ────
interface TokenRow {
  id: number;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
}

async function loadAdToken(): Promise<TokenRow | null> {
  const supabase = getSupabase();
  const { data } = await supabase
    .from("qianchuan_tokens").select("*").eq("id", 1).single();
  return data;
}

async function saveAdToken(t: { access_token: string; refresh_token: string | null; expires_at: string }) {
  const supabase = getSupabase();
  await supabase.from("qianchuan_tokens").update({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_at,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);
}

async function refreshAdToken(): Promise<string> {
  const appId = Deno.env.get("JULIANGAD_APP_ID")!;
  const secret = Deno.env.get("JULIANGAD_SECRET")!;
  const t = await loadAdToken();
  if (!t?.refresh_token) throw new Error("巨量广告无 refresh_token，需重新授权");
  const resp = await fetch(`${AD_API}/oauth2/refresh_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: Number(appId), secret, grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    await saveAdToken({ access_token: "", refresh_token: null, expires_at: new Date(0).toISOString() });
    throw new Error(`巨量广告 token 刷新失败 [${data.code}]: ${data.message}，需重新授权`);
  }
  const expiresAt = new Date(Date.now() + (data.data.expires_in || 86400) * 1000).toISOString();
  await saveAdToken({ access_token: data.data.access_token, refresh_token: data.data.refresh_token || t.refresh_token, expires_at: expiresAt });
  console.log("🔄 巨量广告 Token 已刷新 (id=1)");
  return data.data.access_token;
}

async function getAdToken(): Promise<string> {
  const t = await loadAdToken();
  if (!t?.access_token) throw new Error("巨量广告未授权，请先访问 /auth 完成授权");
  const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  if (Date.now() < expiresAt - 60_000) return t.access_token;
  if (t.refresh_token) return await refreshAdToken();
  throw new Error("巨量广告 token 已过期且无 refresh_token，需重新授权");
}

async function exchangeAdAuthCode(authCode: string) {
  const appId = Deno.env.get("JULIANGAD_APP_ID")!;
  const secret = Deno.env.get("JULIANGAD_SECRET")!;
  const resp = await fetch(`${AD_API}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: Number(appId), secret, grant_type: "auth_code", auth_code: authCode }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`auth_code 换 token 失败 [${data.code}]: ${data.message}`);
  const expiresAt = new Date(Date.now() + (data.data.expires_in || 86400) * 1000).toISOString();
  await saveAdToken({ access_token: data.data.access_token, refresh_token: data.data.refresh_token || null, expires_at: expiresAt });
  console.log("✅ 巨量广告 Token 存入数据库 (id=1)");
  return data.data;
}

// ──── API 工具 ────
function toQueryParam(v: unknown): string {
  if (Array.isArray(v) || (typeof v === "object" && v !== null)) return JSON.stringify(v);
  return String(v);
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function callCustomReport(params: Record<string, unknown>) {
  const token = await getAdToken();
  const url = new URL("https://api.oceanengine.com/open_api/v3.0/report/custom/get/");
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, toQueryParam(v));
  });
  const resp = await fetch(url.toString(), { headers: { "Access-Token": token } });
  const data = await resp.json();
  if (data.code === 40110 || data.code === 40100) {
    const newToken = await refreshAdToken();
    const retryUrl = new URL("https://api.oceanengine.com/open_api/v3.0/report/custom/get/");
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) retryUrl.searchParams.set(k, toQueryParam(v));
    });
    const retryResp = await fetch(retryUrl.toString(), { headers: { "Access-Token": newToken } });
    return await retryResp.json();
  }
  return data;
}

// ──── 主入口 ────
serve(async (req: Request) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/juliangad-proxy/, "").replace(/\/$/, "") || "/";

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // ── GET /auth ── 生成巨量广告授权链接 ──
  // redirect_uri 指向 qianchuan-proxy/callback（已在字节 App 注册），该端点会存到 id=1
  if (req.method === "GET" && path === "/auth") {
    const redirectUri = "https://nbfiltgqklzdfaibyeka.supabase.co/functions/v1/qianchuan-proxy/callback";
    const authUrl = `https://ad.oceanengine.com/openapi/audit/oauth.html?app_id=${Deno.env.get("JULIANGAD_APP_ID")}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    return new Response(JSON.stringify({ ok: true, auth_url: authUrl }), {
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  // ── GET /callback ── OAuth 回调，换 token 存 id=1 ──
  if (req.method === "GET" && path === "/callback") {
    const authCode = url.searchParams.get("auth_code");
    if (!authCode) return new Response("<h1>❌ 缺少 auth_code</h1>", { status: 400, headers: { ...CORS, "content-type": "text/html; charset=utf-8" } });
    try {
      const tokenData = await exchangeAdAuthCode(authCode);
      return new Response(
        `<h1>✅ 巨量广告授权成功！</h1><p>有效期: ${((tokenData.expires_in || 86400) / 3600).toFixed(1)} 小时</p><p>refresh_token: ${tokenData.refresh_token ? "已获取 ✓" : "未获取"}</p><p style="color:green;font-weight:bold">Token 已存入数据库 (id=1)，可以关闭此页面。</p>`,
        { headers: { ...CORS, "content-type": "text/html; charset=utf-8" } },
      );
    } catch (e) {
      return new Response(`<h1>❌ 授权失败</h1><p>${String(e)}</p>`, { status: 500, headers: { ...CORS, "content-type": "text/html; charset=utf-8" } });
    }
  }

  // ── GET /status ── 检查授权状态 ──
  if (req.method === "GET" && path === "/status") {
    try {
      const t = await loadAdToken();
      const expiresAt = t?.expires_at ? new Date(t.expires_at).getTime() : 0;
      const isValid = !!(t?.access_token && Date.now() < expiresAt - 60_000);
      return new Response(JSON.stringify({
        ok: isValid, authenticated: isValid,
        hasRefreshToken: !!t?.refresh_token,
        expiresIn: isValid ? Math.round((expiresAt - Date.now()) / 1000) : 0,
      }), { headers: { ...CORS, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  // ── GET /snapshots ── 快照列表 ──
  if (req.method === "GET" && path === "/snapshots") {
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("ad_snapshots")
        .select("id, name, start_date, end_date, account_mode, saved_at")
        .order("saved_at", { ascending: false }).limit(50);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, data }), { headers: { ...CORS, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  // ── GET /snapshot?id=xxx ── 单条快照 ──
  if (req.method === "GET" && path === "/snapshot") {
    const id = url.searchParams.get("id");
    if (!id) return new Response(JSON.stringify({ ok: false, error: "缺少 id" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
    try {
      const supabase = getSupabase();
      const { data, error } = await supabase.from("ad_snapshots").select("*").eq("id", id).single();
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, data }), { headers: { ...CORS, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  // ── POST /snapshot ── 保存快照 ──
  if (req.method === "POST" && path === "/snapshot") {
    try {
      const body = await req.json();
      const supabase = getSupabase();
      const { data, error } = await supabase.from("ad_snapshots").insert({
        name: body.name || null,
        start_date: body.start_date,
        end_date: body.end_date,
        account_mode: body.account_mode || "all",
        perf_data: body.perf_data || null,
        caoshu_data: body.caoshu_data || null,
      }).select("id, saved_at").single();
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true, data }), { headers: { ...CORS, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  // ── DELETE /snapshot?id=xxx ── 删除快照 ──
  if (req.method === "DELETE" && path === "/snapshot") {
    const id = url.searchParams.get("id");
    if (!id) return new Response(JSON.stringify({ ok: false, error: "缺少 id" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
    try {
      const supabase = getSupabase();
      const { error } = await supabase.from("ad_snapshots").delete().eq("id", id);
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  // ── GET /metrics ── 查询可用指标 ──
  if (req.method === "GET" && path === "/metrics") {
    const advertiserId = url.searchParams.get("advertiser_id");
    const dataTopic = url.searchParams.get("data_topic") || "BASIC_DATA";
    if (!advertiserId) return new Response(JSON.stringify({ ok: false, error: "缺少 advertiser_id" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
    try {
      const token = await getAdToken();
      const metricsUrl = new URL("https://api.oceanengine.com/open_api/v3.0/report/custom/config/get/");
      metricsUrl.searchParams.set("advertiser_id", advertiserId);
      metricsUrl.searchParams.set("data_topics", JSON.stringify([dataTopic]));
      const resp = await fetch(metricsUrl.toString(), { headers: { "Access-Token": token } });
      const data = await resp.json();
      return new Response(JSON.stringify({ ok: true, data }), { headers: { ...CORS, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  // ── GET /accounts ── 已授权账户列表 ──
  if (req.method === "GET" && path === "/accounts") {
    try {
      const token = await getAdToken();
      const resp = await fetch(`${AD_API}/oauth2/application/accounts`, { headers: { "Access-Token": token } });
      const data = await resp.json();
      return new Response(JSON.stringify({ ok: true, data }), { headers: { ...CORS, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  // ── POST ── 巨量广告报表查询 ──
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action || "getReport";
    try {
      const advertiserId = body.advertiser_id || Number(Deno.env.get("JULIANGAD_ADVERTISER_ID")) || 0;
      if (!advertiserId) return new Response(JSON.stringify({ ok: false, error: "缺少 advertiser_id" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });

      const endDate = body.end_date || formatDate(new Date());
      const startDate = body.start_date || formatDate(new Date(Date.now() - 7 * 86400_000));

      const defaultMetrics = [
        "cost", "show_cnt", "click_cnt", "ctr", "cpm_platform",
        "convert_cnt", "in_app_order_count", "in_app_order_gmv", "in_app_order_roi",
      ];
      const params: Record<string, unknown> = action === "getProjectReport" ? {
        advertiser_id: advertiserId,
        data_topic: "BASIC_DATA",
        dimensions: ["cdp_project_id"],
        metrics: defaultMetrics,
        start_time: startDate + " 00:00:00",
        end_time: endDate + " 23:59:59",
        filters: body.filters || [],
        order_by: [{ field: "cost", type: "DESC" }],
        page: body.page || 1,
        page_size: body.page_size || 100,
      } : {
        advertiser_id: advertiserId,
        data_topic: body.data_topic || "BASIC_DATA",
        dimensions: body.dimensions || ["stat_time_day"],
        metrics: body.metrics || defaultMetrics,
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
      }), { headers: { ...CORS, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  return new Response(JSON.stringify({ ok: false, error: "不支持的请求" }), { status: 405, headers: { ...CORS, "content-type": "application/json" } });
});
