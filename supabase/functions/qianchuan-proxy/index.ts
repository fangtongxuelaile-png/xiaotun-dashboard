// Supabase Edge Function: qianchuan-proxy
// 巨量千川数据中转代理（仅千川，与巨量广告完全隔离）
// token 存储：qianchuan_tokens id=2
// 巨量广告请使用独立的 juliangad-proxy

// @ts-ignore
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
// @ts-ignore
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const QC_API = "https://ad.oceanengine.com/open_api";

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

// ──── 千川 token（多账号存储）────
interface TokenRow {
  advertiser_id: number;
  advertiser_name: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
}

async function loadQcToken(advertiserId: number): Promise<TokenRow | null> {
  const supabase = getSupabase();
  // 优先尝试新表 qianchuan_account_tokens
  const { data, error } = await supabase.from("qianchuan_account_tokens").select("*").eq("advertiser_id", advertiserId).single();
  if (data) return data;

  // 如果新表不存在或无记录，fallback 到旧表（仅 CLBX 账号 1837047110032394）
  if (advertiserId === 1837047110032394) {
    const { data: oldData } = await supabase.from("qianchuan_tokens").select("*").eq("id", 2).single();
    if (oldData) {
      return {
        advertiser_id: 1837047110032394,
        advertiser_name: "CLBX官方旗舰店",
        access_token: oldData.access_token,
        refresh_token: oldData.refresh_token,
        expires_at: oldData.expires_at,
      };
    }
  }
  return null;
}

async function saveQcToken(advertiserId: number, advertiserName: string | null, t: { access_token: string; refresh_token: string | null; expires_at: string }) {
  const supabase = getSupabase();
  await supabase.from("qianchuan_account_tokens").upsert({
    advertiser_id: advertiserId,
    advertiser_name: advertiserName,
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_at,
    updated_at: new Date().toISOString(),
  }, { onConflict: "advertiser_id" });
}

async function refreshQcToken(advertiserId: number): Promise<string> {
  const appId = Deno.env.get("QIANCHUAN_APP_ID")!;
  const secret = Deno.env.get("QIANCHUAN_SECRET")!;
  const t = await loadQcToken(advertiserId);
  if (!t?.refresh_token) throw new Error(`千川账号 ${advertiserId} 无 refresh_token，需重新授权`);
  const resp = await fetch(`${QC_API}/oauth2/refresh_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: Number(appId), secret, grant_type: "refresh_token", refresh_token: t.refresh_token }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    await saveQcToken(advertiserId, t.advertiser_name, { access_token: "", refresh_token: null, expires_at: new Date(0).toISOString() });
    throw new Error(`千川 token 刷新失败 [${data.code}]: ${data.message}，需重新授权`);
  }
  const expiresAt = new Date(Date.now() + (data.data.expires_in || 86400) * 1000).toISOString();
  await saveQcToken(advertiserId, t.advertiser_name, { access_token: data.data.access_token, refresh_token: data.data.refresh_token || t.refresh_token, expires_at: expiresAt });
  console.log(`🔄 千川 Token 已刷新 (account=${advertiserId})`);
  return data.data.access_token;
}

async function getQcToken(advertiserId: number): Promise<string> {
  const t = await loadQcToken(advertiserId);
  if (!t?.access_token) throw new Error(`千川账号 ${advertiserId} 未授权，请先完成 OAuth 授权`);
  const expiresAt = t.expires_at ? new Date(t.expires_at).getTime() : 0;
  if (Date.now() < expiresAt - 60_000) return t.access_token;
  if (t.refresh_token) return await refreshQcToken(advertiserId);
  throw new Error(`千川账号 ${advertiserId} token 已过期且无 refresh_token，需重新授权`);
}

async function exchangeQcAuthCode(authCode: string) {
  const appId = Deno.env.get("QIANCHUAN_APP_ID")!;
  const secret = Deno.env.get("QIANCHUAN_SECRET")!;

  // Step 1: auth_code 换 token
  const resp = await fetch(`${QC_API}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: Number(appId), secret, grant_type: "auth_code", auth_code: authCode }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`千川 auth_code 换 token 失败 [${data.code}]: ${data.message}`);
  const expiresAt = new Date(Date.now() + (data.data.expires_in || 86400) * 1000).toISOString();
  const tokenData = { access_token: data.data.access_token, refresh_token: data.data.refresh_token || null, expires_at: expiresAt };

  // Step 2: 用新 token 查询绑定的投放账号列表
  const advertResp = await fetch(`${QC_API}/oauth2/advertiser/get/?app_id=${appId}`, {
    headers: { "Access-Token": data.data.access_token },
  });
  const advertData = await advertResp.json();
  const advertiserInfos: Array<{ advertiser_id: number; advertiser_name: string }> = advertData?.data?.advertiser_infos || [];

  // Step 3: 逐个存 token（同一 token 授权了多个账号）
  let savedCount = 0;
  if (advertiserInfos.length > 0) {
    for (const info of advertiserInfos) {
      await saveQcToken(info.advertiser_id, info.advertiser_name, tokenData);
    }
    savedCount = advertiserInfos.length;
    console.log(`✅ 千川 Token 存入新表 (${savedCount} 个账号: ${advertiserInfos.map(i => i.advertiser_id).join(",")})`);
  } else {
    // oauth2/advertiser/get/ 没有直接绑定账号 → 尝试纵横工作台（CC）子账号列表
    // 常见于代理商 / 纵横账号授权，token 可以用于 CC 下所有子账号
    const supabase = getSupabase();

    // 先把 token 存旧表 id=2 以备 fallback
    await supabase.from("qianchuan_tokens").upsert({
      id: 2,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: tokenData.expires_at,
      updated_at: new Date().toISOString(),
    }, { onConflict: "id" });

    // 查 CC 工作台下的千川账号
    const CC_ACCOUNT_ID = "1697615888670732";
    const ccUrl = new URL(`${QC_API}/2/customer_center/advertiser/list/`);
    ccUrl.searchParams.set("cc_account_id", CC_ACCOUNT_ID);
    ccUrl.searchParams.set("account_source", "QIANCHUAN");
    ccUrl.searchParams.set("page_size", "100");
    const ccResp = await fetch(ccUrl.toString(), { headers: { "Access-Token": tokenData.access_token } });
    const ccData = await ccResp.json();
    const ccAccounts: Array<{ advertiser_id: number; advertiser_name: string }> = ccData?.data?.list || [];

    if (ccAccounts.length > 0) {
      for (const a of ccAccounts) {
        await saveQcToken(a.advertiser_id, a.advertiser_name, tokenData);
      }
      savedCount = ccAccounts.length;
      console.log(`✅ 千川 Token 经 CC 存入新表 (${savedCount} 个账号)`);
    } else {
      console.log("⚠️ oauth2/advertiser/get/ 和 CC 均无账号，token 仅存入旧表 id=2");
    }
  }
  return { ...data.data, bound_accounts: savedCount };
}

// ──── 巨量广告 token（id=1）写入（供 /callback 端点使用）────
async function saveAdTokenToId1(t: { access_token: string; refresh_token: string | null; expires_at: string }) {
  const supabase = getSupabase();
  await supabase.from("qianchuan_tokens").update({
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: t.expires_at,
    updated_at: new Date().toISOString(),
  }).eq("id", 1);
}

async function exchangeAdAuthCodeToId1(authCode: string) {
  const appId = Deno.env.get("JULIANGAD_APP_ID")!;
  const secret = Deno.env.get("JULIANGAD_SECRET")!;
  const resp = await fetch("https://ad.oceanengine.com/open_api/oauth2/access_token/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: Number(appId), secret, grant_type: "auth_code", auth_code: authCode }),
  });
  const data = await resp.json();
  if (data.code !== 0) throw new Error(`巨量广告 auth_code 换 token 失败 [${data.code}]: ${data.message}`);
  const expiresAt = new Date(Date.now() + (data.data.expires_in || 86400) * 1000).toISOString();
  await saveAdTokenToId1({ access_token: data.data.access_token, refresh_token: data.data.refresh_token || null, expires_at: expiresAt });
  console.log("✅ 巨量广告 Token 已存入数据库 (id=1)");
  return data.data;
}

// ──── 工具函数 ────
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

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // ── GET /callback ── OAuth 回调（巨量广告 + 千川共用）──
  // 通过 app_id 参数区分：千川 app_id=1868772551039212，其余视为巨量广告
  if (req.method === "GET" && path === "/callback") {
    const authCode = url.searchParams.get("auth_code");
    const callbackAppId = url.searchParams.get("app_id");
    if (!authCode) return new Response("<h1>❌ 缺少 auth_code</h1>", { status: 400, headers: { ...CORS, "content-type": "text/html; charset=utf-8" } });
    const isQianchuan = callbackAppId === Deno.env.get("QIANCHUAN_APP_ID");
    try {
      if (isQianchuan) {
        // 千川授权回调
        const tokenData = await exchangeQcAuthCode(authCode);
        const boundAccounts = (tokenData as Record<string, unknown>).bound_accounts as number || 0;
        return new Response(
          `<h1>✅ 千川授权成功！</h1><p>有效期: ${(((tokenData.expires_in as number) || 86400) / 3600).toFixed(1)} 小时</p><p>绑定账号数: ${boundAccounts} 个</p><p style="color:green;font-weight:bold">千川 Token 已存入数据库，可以关闭此页面。</p>`,
          { headers: { ...CORS, "content-type": "text/html; charset=utf-8" } },
        );
      } else {
        // 巨量广告授权回调
        const tokenData = await exchangeAdAuthCodeToId1(authCode);
        return new Response(
          `<h1>✅ 巨量广告授权成功！</h1><p>有效期: ${(((tokenData.expires_in as number) || 86400) / 3600).toFixed(1)} 小时</p><p>refresh_token: ${tokenData.refresh_token ? "已获取 ✓" : "未获取"}</p><p style="color:green;font-weight:bold">巨量广告 Token 已存入数据库 (id=1)，可以关闭此页面。</p>`,
          { headers: { ...CORS, "content-type": "text/html; charset=utf-8" } },
        );
      }
    } catch (e) {
      return new Response(`<h1>❌ 授权失败</h1><p>${String(e)}</p>`, { status: 500, headers: { ...CORS, "content-type": "text/html; charset=utf-8" } });
    }
  }

  // ── GET /qc-auth ── 生成千川授权链接 ──
  if (req.method === "GET" && path === "/qc-auth") {
    const authUrl = `https://qianchuan.jinritemai.com/openapi/qc/audit/oauth.html?app_id=${Deno.env.get("QIANCHUAN_APP_ID")}`;
    return new Response(JSON.stringify({ ok: true, auth_url: authUrl }), {
      headers: { ...CORS, "content-type": "application/json" },
    });
  }

  // ── GET /qc-callback ── OAuth 回调，换 token 存 id=2 ──
  if (req.method === "GET" && path === "/qc-callback") {
    const authCode = url.searchParams.get("auth_code");
    if (!authCode) return new Response("<h1>❌ 缺少 auth_code</h1>", { status: 400, headers: { ...CORS, "content-type": "text/html; charset=utf-8" } });
    try {
      const tokenData = await exchangeQcAuthCode(authCode);
      return new Response(
        `<h1>✅ 千川授权成功！</h1><p>有效期: ${((tokenData.expires_in || 86400) / 3600).toFixed(1)} 小时</p><p>refresh_token: ${tokenData.refresh_token ? "已获取 ✓" : "未获取"}</p><p style="color:green;font-weight:bold">千川 Token 已存入数据库 (id=2)，可以关闭此页面。</p>`,
        { headers: { ...CORS, "content-type": "text/html; charset=utf-8" } },
      );
    } catch (e) {
      return new Response(`<h1>❌ 授权失败</h1><p>${String(e)}</p>`, { status: 500, headers: { ...CORS, "content-type": "text/html; charset=utf-8" } });
    }
  }

  // ── GET /qc-status ── 检查千川授权状态 ──
  if (req.method === "GET" && path === "/qc-status") {
    try {
      const t = await loadQcToken();
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

  // ── POST ── 千川数据查询入口 ──
  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const action: string = body.action || "";
    try {
      // ── 不需要 advertiser_id 的 action 优先处理 ──

      // ── 列出所有已授权账号 ──
      if (action === "listAuthorizedAccounts") {
        const supabase = getSupabase();
        const { data: newAccounts } = await supabase.from("qianchuan_account_tokens").select("*");
        const accounts = newAccounts || [];

        if (!accounts.length) {
          const { data: oldToken } = await supabase.from("qianchuan_tokens").select("*").eq("id", 2).single();
          if (oldToken?.access_token) {
            accounts.push({
              advertiser_id: 1837047110032394,
              advertiser_name: "CLBX官方旗舰店",
              access_token: oldToken.access_token,
              refresh_token: oldToken.refresh_token,
              expires_at: oldToken.expires_at,
            });
          }
        }
        return new Response(JSON.stringify({ ok: true, action, data: accounts }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 刷新所有账号的 token ──
      if (action === "refreshAllTokens") {
        const supabase = getSupabase();
        const { data: accounts } = await supabase.from("qianchuan_account_tokens").select("advertiser_id, refresh_token, expires_at");
        const result: Array<{ advertiser_id: number; status: string; error?: string }> = [];

        for (const acct of (accounts || [])) {
          const { advertiser_id, refresh_token, expires_at } = acct;
          if (!refresh_token) {
            result.push({ advertiser_id, status: "⚠️ 无 refresh_token，需重新 OAuth 授权" });
            continue;
          }
          const expiresMs = expires_at ? new Date(expires_at).getTime() : 0;
          if (Date.now() < expiresMs - 60_000) {
            result.push({ advertiser_id, status: "✅ token 有效，无需刷新" });
            continue;
          }
          try {
            await refreshQcToken(advertiser_id);
            result.push({ advertiser_id, status: "✅ 已刷新" });
          } catch (e) {
            result.push({ advertiser_id, status: "❌ 刷新失败", error: String(e) });
          }
        }

        console.log(`✅ refreshAllTokens 完成: ${result.map(r => `${r.advertiser_id}=${r.status}`).join(", ")}`);
        return new Response(JSON.stringify({ ok: true, action, data: result }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 抖店每日数据存储（不需要 advertiser_id）──
      if (action === "upsertDoudianStats") {
        const supabase = getSupabase();
        const rows: Array<{
          date: string;
          gmv: number;
          orders: number;
          refund_amount?: number;
          refund_orders?: number;
        }> = body.rows || [];

        if (!rows.length) {
          return new Response(JSON.stringify({ ok: false, error: "rows 不能为空" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
        }

        const records = rows.map(r => ({
          date: r.date,
          gmv: Number(r.gmv) || 0,
          orders: Number(r.orders) || 0,
          refund_amount: Number(r.refund_amount) || 0,
          refund_orders: Number(r.refund_orders) || 0,
          source: "manual",
          updated_at: new Date().toISOString(),
        }));

        const { error, count } = await supabase
          .from("doudian_daily_stats")
          .upsert(records, { onConflict: "date" });

        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
        }

        return new Response(JSON.stringify({ ok: true, action, inserted: records.length, msg: `✅ 已存入 ${records.length} 条抖店日数据` }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 查询抖店每日数据 ──
      if (action === "getDoudianStats") {
        const supabase = getSupabase();
        const startDate = body.start_date || "2026-01-01";
        const endDate   = body.end_date   || new Date().toISOString().slice(0, 10);

        const { data, error } = await supabase
          .from("doudian_daily_stats")
          .select("date,gmv,orders,refund_amount,refund_orders,net_gmv")
          .gte("date", startDate)
          .lte("date", endDate)
          .order("date", { ascending: true });

        if (error) {
          return new Response(JSON.stringify({ ok: false, error: error.message }), { status: 500, headers: { ...CORS, "content-type": "application/json" } });
        }

        // 汇总
        const totalGmv    = (data || []).reduce((s, r) => s + (r.gmv || 0), 0);
        const totalOrders = (data || []).reduce((s, r) => s + (r.orders || 0), 0);
        const totalNetGmv = (data || []).reduce((s, r) => s + (r.net_gmv || 0), 0);

        return new Response(JSON.stringify({
          ok: true, action,
          data: data || [],
          summary: { total_gmv: totalGmv, total_orders: totalOrders, total_net_gmv: totalNetGmv, days: (data || []).length },
          meta: { startDate, endDate },
        }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 以下 action 均需要 advertiser_id ──
      const advertiserId = body.advertiser_id || 0;
      if (!advertiserId) return new Response(JSON.stringify({ ok: false, error: "缺少 advertiser_id" }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });

      const token = await getQcToken(advertiserId);

      // ── 一次性迁移：把 cc 下所有账号写入新表 ──
      if (action === "migrateAccountTokens") {
        const supabase = getSupabase();
        // 取旧 token（id=2）
        const { data: oldRow } = await supabase.from("qianchuan_tokens").select("*").eq("id", 2).single();
        if (!oldRow?.access_token) return new Response(JSON.stringify({ ok: false, error: "旧表无 token" }), { headers: { ...CORS, "content-type": "application/json" } });

        const tokenData = { access_token: oldRow.access_token, refresh_token: oldRow.refresh_token || null, expires_at: oldRow.expires_at };

        // 查纵横工作台下所有账号
        const ccUrl = new URL(`${QC_API}/2/customer_center/advertiser/list/`);
        ccUrl.searchParams.set("cc_account_id", "1697615888670732");
        ccUrl.searchParams.set("account_source", "QIANCHUAN");
        ccUrl.searchParams.set("page_size", "100");
        const ccResp = await fetch(ccUrl.toString(), { headers: { "Access-Token": oldRow.access_token } });
        const ccData = await ccResp.json();
        const accounts: Array<{ advertiser_id: number; advertiser_name: string }> = ccData?.data?.list || [];

        const results: string[] = [];
        for (const a of accounts) {
          await saveQcToken(a.advertiser_id, a.advertiser_name, tokenData);
          results.push(`✅ ${a.advertiser_id} ${a.advertiser_name}`);
        }
        return new Response(JSON.stringify({ ok: true, action, migrated: results.length, accounts: results }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 获取店铺下千川账户列表 ──
      if (action === "getShopAdvertisers") {
        const qcUrl = new URL(`${QC_API}/qianchuan/shop/advertiser/list/`);
        qcUrl.searchParams.set("advertiser_id", String(advertiserId));
        qcUrl.searchParams.set("page_size", "100");
        const resp = await fetch(qcUrl.toString(), { headers: { "Access-Token": token } });
        const rawText = await resp.text();
        let data: unknown;
        try { data = JSON.parse(rawText); } catch { data = { raw: rawText.slice(0, 500) }; }
        return new Response(JSON.stringify({ ok: true, action, data }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 获取纵横工作台下千川账户列表 ──
      if (action === "getQianchuanAccounts") {
        const qcUrl = new URL(`${QC_API}/2/customer_center/advertiser/list/`);
        qcUrl.searchParams.set("cc_account_id", String(advertiserId));
        qcUrl.searchParams.set("account_source", "QIANCHUAN");
        qcUrl.searchParams.set("page_size", "100");
        const resp = await fetch(qcUrl.toString(), { headers: { "Access-Token": token } });
        const rawText = await resp.text();
        let data: unknown;
        try { data = JSON.parse(rawText); } catch { data = { raw: rawText.slice(0, 500) }; }
        return new Response(JSON.stringify({ ok: true, action, data }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 全域投放汇总报表（CLBX 账户，仅 stat_cost 有效）──
      if (action === "getUniPromotionReport") {
        const endDate   = body.end_date   || formatDate(new Date());
        const startDate = body.start_date || formatDate(new Date(Date.now() - 7 * 86400_000));
        const qcUrl = new URL("https://ad.oceanengine.com/open_api/v1.0/qianchuan/report/uni_promotion/get/");
        qcUrl.searchParams.set("advertiser_id", String(advertiserId));
        qcUrl.searchParams.set("start_date", startDate);
        qcUrl.searchParams.set("end_date", endDate);
        qcUrl.searchParams.set("fields", JSON.stringify(["stat_cost"]));
        const resp = await fetch(qcUrl.toString(), { headers: { "Access-Token": token } });
        const data = await resp.json();
        return new Response(JSON.stringify({ ok: true, action, data, meta: { startDate, endDate } }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 全域投放周粒度报表（uni_promotion 单日返回 50000，按7天分段查）──
      if (action === "getUniPromotionDailyReport") {
        const endDate   = body.end_date   || formatDate(new Date());
        const startDate = body.start_date || formatDate(new Date(Date.now() - 30 * 86400_000));

        // 把日期区间切成 7 天一段
        const chunks: Array<{ start: string; end: string }> = [];
        const cur = new Date(startDate + "T00:00:00Z");
        const endD = new Date(endDate + "T00:00:00Z");
        while (cur <= endD) {
          const chunkStart = formatDate(new Date(cur.getTime()));
          cur.setUTCDate(cur.getUTCDate() + 6);
          const chunkEnd = formatDate(cur > endD ? endD : new Date(cur.getTime()));
          chunks.push({ start: chunkStart, end: chunkEnd });
          cur.setUTCDate(cur.getUTCDate() + 1);
        }

        const weekly = await Promise.all(chunks.map(async (chunk) => {
          const qcUrl = new URL("https://ad.oceanengine.com/open_api/v1.0/qianchuan/report/uni_promotion/get/");
          qcUrl.searchParams.set("advertiser_id", String(advertiserId));
          qcUrl.searchParams.set("start_date", chunk.start);
          qcUrl.searchParams.set("end_date", chunk.end);
          qcUrl.searchParams.set("fields", JSON.stringify(["stat_cost"]));
          try {
            const resp = await fetch(qcUrl.toString(), { headers: { "Access-Token": token } });
            const d = await resp.json();
            const cost = d?.data?.stat_cost;
            return { date: chunk.start, end_date: chunk.end, stat_cost: (cost != null && cost !== "-") ? Number(cost) : 0 };
          } catch {
            return { date: chunk.start, end_date: chunk.end, stat_cost: 0 };
          }
        }));

        return new Response(JSON.stringify({ ok: true, action, data: weekly, meta: { startDate, endDate, granularity: "weekly", weeks: weekly.length } }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 千川账户级报表 ──
      if (action === "getQianchuanReport") {
        const endDate   = body.end_date   || formatDate(new Date());
        const startDate = body.start_date || formatDate(new Date(Date.now() - 7 * 86400_000));
        const qcUrl = new URL("https://ad.oceanengine.com/open_api/v1.0/qianchuan/report/advertiser/get/");
        qcUrl.searchParams.set("advertiser_id", String(advertiserId));
        qcUrl.searchParams.set("start_date", startDate);
        qcUrl.searchParams.set("end_date", endDate);
        qcUrl.searchParams.set("fields", JSON.stringify(body.fields || [
          "stat_cost", "show_cnt", "click_cnt", "ctr", "cpm_platform",
          "pay_order_count", "pay_order_amount", "create_order_roi",
        ]));
        qcUrl.searchParams.set("filtering", JSON.stringify({
          marketing_goal: body.marketing_goal || "ALL",
          ...(body.order_platform ? { order_platform: body.order_platform } : {}),
        }));
        if (body.time_granularity) qcUrl.searchParams.set("time_granularity", body.time_granularity);
        qcUrl.searchParams.set("page", String(body.page || 1));
        qcUrl.searchParams.set("page_size", String(body.page_size || 100));
        const resp = await fetch(qcUrl.toString(), { headers: { "Access-Token": token } });
        const rawText = await resp.text();
        let data: unknown;
        try { data = JSON.parse(rawText); } catch { data = { raw: rawText.slice(0, 500) }; }
        return new Response(JSON.stringify({ ok: true, action, data, meta: { startDate, endDate } }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 今日直播数据（自动获取 aweme_id，查当日竞价投放直播数据）──
      if (action === "getLiveData") {
        const date = body.date || formatDate(new Date());
        // 1. 拿绑定的抖音号列表
        const awemeUrl = new URL(`${QC_API}/v1.0/qianchuan/aweme/authorized/get/`);
        awemeUrl.searchParams.set("advertiser_id", String(advertiserId));
        const awemeResp = await fetch(awemeUrl.toString(), { headers: { "Access-Token": token } });
        const awemeJson = await awemeResp.json();
        const awemeList: Array<Record<string, unknown>> = awemeJson?.data?.aweme_id_list || [];
        if (!awemeList.length) {
          return new Response(JSON.stringify({ ok: true, action, data: [], meta: { date, msg: "该账号无绑定抖音号" } }), { headers: { ...CORS, "content-type": "application/json" } });
        }
        // 2. 逐个抖音号查今日直播数据
        const liveResults = await Promise.all(awemeList.map(async (aweme) => {
          const liveUrl = new URL(`${QC_API}/v1.0/qianchuan/report/live/get/`);
          liveUrl.searchParams.set("advertiser_id", String(advertiserId));
          liveUrl.searchParams.set("aweme_id", String(aweme.aweme_id));
          liveUrl.searchParams.set("start_time", date + " 00:00:00");
          liveUrl.searchParams.set("end_time", date + " 23:59:59");
          liveUrl.searchParams.set("fields", JSON.stringify([
            "stat_cost", "show_cnt", "click_cnt", "pay_order_count", "pay_order_amount", "cpm_platform",
          ]));
          try {
            const resp = await fetch(liveUrl.toString(), { headers: { "Access-Token": token } });
            const d = await resp.json();
            return {
              aweme_id: aweme.aweme_id,
              aweme_name: aweme.aweme_name,
              aweme_show_id: aweme.aweme_show_id,
              has_live_permission: aweme.aweme_has_live_permission,
              live_data: d?.data || null,
              api_code: d?.code,
            };
          } catch (e) {
            return { aweme_id: aweme.aweme_id, aweme_name: aweme.aweme_name, live_data: null, error: String(e) };
          }
        }));
        return new Response(JSON.stringify({ ok: true, action, data: liveResults, meta: { date } }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 账户余额查询（通用/竞价/品牌三项余额）──
      if (action === "getAccountBalance") {
        const balUrl = new URL(`${QC_API}/v1.0/qianchuan/account/balance/get/`);
        balUrl.searchParams.set("advertiser_id", String(advertiserId));
        const resp = await fetch(balUrl.toString(), { headers: { "Access-Token": token } });
        const data = await resp.json();
        return new Response(JSON.stringify({ ok: true, action, data }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 广告计划维度报表（竞价推广 ad 级别）──
      if (action === "getAdReport") {
        const endDate   = body.end_date   || formatDate(new Date());
        const startDate = body.start_date || formatDate(new Date(Date.now() - 7 * 86400_000));
        const adUrl = new URL(`${QC_API}/v1.0/qianchuan/report/ad/get/`);
        adUrl.searchParams.set("advertiser_id", String(advertiserId));
        adUrl.searchParams.set("start_date", startDate);
        adUrl.searchParams.set("end_date", endDate);
        adUrl.searchParams.set("fields", JSON.stringify(body.fields || [
          "stat_cost", "show_cnt", "click_cnt", "ctr",
          "pay_order_count", "pay_order_amount", "create_order_roi",
        ]));
        const filtering = { marketing_goal: "ALL", ...(body.filtering || {}) };
        adUrl.searchParams.set("filtering", JSON.stringify(filtering));
        adUrl.searchParams.set("order_by", JSON.stringify([{ field: "stat_cost", type: "DESC" }]));
        adUrl.searchParams.set("page", String(body.page || 1));
        adUrl.searchParams.set("page_size", String(body.page_size || 20));
        const resp = await fetch(adUrl.toString(), { headers: { "Access-Token": token } });
        const data = await resp.json();
        return new Response(JSON.stringify({ ok: true, action, data, meta: { startDate, endDate } }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 竞价推广日粒度报表（自动按月分段，解决30天限制）──
      // 适用于 LCM 系列账号，1月-6月全量日粒度消耗数据
      if (action === "getAdDailyReport") {
        const endDate   = body.end_date   || formatDate(new Date(Date.now() - 86400_000));
        const startDate = body.start_date || "2026-01-01";

        // 把日期区间切成 ≤30 天一段
        const chunks: Array<{ start: string; end: string }> = [];
        const cur = new Date(startDate + "T00:00:00Z");
        const endD = new Date(endDate + "T00:00:00Z");
        while (cur <= endD) {
          const chunkEnd = new Date(cur);
          chunkEnd.setUTCDate(chunkEnd.getUTCDate() + 29); // 最多30天
          if (chunkEnd > endD) chunkEnd.setTime(endD.getTime());
          chunks.push({ start: formatDate(cur), end: formatDate(chunkEnd) });
          cur.setUTCDate(cur.getUTCDate() + 30);
        }

        const fields = body.fields || [
          "stat_cost", "show_cnt", "click_cnt", "ctr",
          "pay_order_count", "pay_order_amount", "create_order_roi",
        ];

        // 按月顺序查询（串行避免限流）
        const allRows: Array<Record<string, unknown>> = [];
        const errors: string[] = [];
        for (const chunk of chunks) {
          const adUrl = new URL(`${QC_API}/v1.0/qianchuan/report/advertiser/get/`);
          adUrl.searchParams.set("advertiser_id", String(advertiserId));
          adUrl.searchParams.set("start_date", chunk.start);
          adUrl.searchParams.set("end_date", chunk.end);
          adUrl.searchParams.set("time_granularity", "TIME_GRANULARITY_DAILY");
          adUrl.searchParams.set("fields", JSON.stringify(fields));
          adUrl.searchParams.set("filtering", JSON.stringify({ marketing_goal: "ALL" }));
          adUrl.searchParams.set("page_size", "100");
          try {
            const resp = await fetch(adUrl.toString(), { headers: { "Access-Token": token } });
            const d = await resp.json();
            const rows: Array<Record<string, unknown>> = (d?.data?.list) || [];
            allRows.push(...rows.map(r => ({ ...r, _chunk: `${chunk.start}~${chunk.end}` })));
            if (d.code !== 0) errors.push(`${chunk.start}~${chunk.end}: [${d.code}] ${d.message}`);
          } catch (e) {
            errors.push(`${chunk.start}~${chunk.end}: ${String(e)}`);
          }
        }

        // 按日期排序
        allRows.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
        return new Response(JSON.stringify({
          ok: true, action,
          data: allRows,
          meta: { startDate, endDate, chunks: chunks.length, total: allRows.length, errors },
        }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      // ── 全域推广按抖音号维度数据 ──
      if (action === "getUniPromotionAuthorData") {
        const endDate   = body.end_date   || formatDate(new Date());
        const startDate = body.start_date || formatDate(new Date(Date.now() - 7 * 86400_000));
        const authUrl = new URL(`${QC_API}/v1.0/qianchuan/report/uni_promotion/dimension_data/author/get/`);
        authUrl.searchParams.set("advertiser_id", String(advertiserId));
        authUrl.searchParams.set("start_date", startDate);
        authUrl.searchParams.set("end_date", endDate);
        authUrl.searchParams.set("fields", JSON.stringify([
          "stat_cost", "show_cnt", "click_cnt", "pay_order_count", "pay_order_amount",
        ]));
        const resp = await fetch(authUrl.toString(), { headers: { "Access-Token": token } });
        const data = await resp.json();
        return new Response(JSON.stringify({ ok: true, action, data, meta: { startDate, endDate } }), { headers: { ...CORS, "content-type": "application/json" } });
      }

      return new Response(JSON.stringify({ ok: false, error: `未知 action: ${action}` }), { status: 400, headers: { ...CORS, "content-type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 502, headers: { ...CORS, "content-type": "application/json" } });
    }
  }

  return new Response(JSON.stringify({ ok: false, error: "不支持的请求" }), { status: 405, headers: { ...CORS, "content-type": "application/json" } });
});
