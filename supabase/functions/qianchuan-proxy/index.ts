// Supabase Edge Function: qianchuan-proxy
// 作用：前端 → 巨量千川 API 的安全中转代理
// - OAuth 认证密钥藏在服务端环境变量，不暴露在公开前端
// - 自动获取/刷新 access_token（24h 过期）
// - 暴露两个 action：getReport（拉取投放报表）/ getAdvertiserInfo（查广告主信息）
//
// 部署前需在 Supabase 配置 secret：
//   QIANCHUAN_APP_ID        = 巨量千川应用 ID
//   QIANCHUAN_SECRET        = 巨量千川应用 Secret
//   QIANCHUAN_ADVERTISER_ID = 广告主 ID（可选，前端可传）
//
// 部署：supabase functions deploy qianchuan-proxy --no-verify-jwt

const QIANCHUAN_API = "https://ad.oceanengine.com/open_api";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

// 缓存 access_token 在全局变量（Edge Function 复用期有效）
let _cachedToken: string | null = null;
let _cachedTokenExpiresAt = 0;

/** 获取或刷新 access_token */
async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (_cachedToken && now < _cachedTokenExpiresAt - 60_000) {
    return _cachedToken;
  }

  const appId = Deno.env.get("QIANCHUAN_APP_ID");
  const secret = Deno.env.get("QIANCHUAN_SECRET");
  if (!appId || !secret) {
    throw new Error("QIANCHUAN_APP_ID / QIANCHUAN_SECRET 未配置");
  }

  const resp = await fetch(`${QIANCHUAN_API}/oauth2/access_token/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: Number(appId),
      secret,
      grant_type: "auth_auth_code",
    }),
  });

  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`千川 OAuth 失败: [${data.code}] ${data.message}`);
  }

  _cachedToken = data.data.access_token;
  _cachedTokenExpiresAt = now + (data.data.expires_in || 86400) * 1000;
  return _cachedToken!;
}

/** 调用千川 API（带 token 自动续期） */
async function callQianchuan(
  path: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const token = await getAccessToken();
  const url = new URL(`${QIANCHUAN_API}${path}`);
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  });

  const resp = await fetch(url.toString(), {
    headers: {
      "Access-Token": token,
      "Content-Type": "application/json",
    },
  });

  const data = await resp.json();
  if (data.code === 40110 || data.code === 40100) {
    // token 失效，清除缓存重试一次
    _cachedToken = null;
    _cachedTokenExpiresAt = 0;
    const newToken = await getAccessToken();
    const retryUrl = new URL(`${QIANCHUAN_API}${path}`);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) retryUrl.searchParams.set(k, String(v));
    });
    const retryResp = await fetch(retryUrl.toString(), {
      headers: { "Access-Token": newToken, "Content-Type": "application/json" },
    });
    return await retryResp.json();
  }
  return data;
}

// ──────────────────────────────────────────
// 主入口
// ──────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ ok: false, error: "仅支持 POST" }),
      { status: 405, headers: { ...CORS, "content-type": "application/json" } },
    );
  }

  const body = await req.json().catch(() => ({}));
  const action: string = body.action || "getReport";

  try {
    // ── action: getAdvertiserInfo ──
    if (action === "getAdvertiserInfo") {
      const advertiserId =
        body.advertiser_id ||
        Number(Deno.env.get("QIANCHUAN_ADVERTISER_ID")) ||
        0;
      if (!advertiserId) {
        return new Response(
          JSON.stringify({ ok: false, error: "缺少 advertiser_id" }),
          { status: 400, headers: { ...CORS, "content-type": "application/json" } },
        );
      }
      const data = await callQianchuan("/2/advertiser/info/", {
        advertiser_ids: `[${advertiserId}]`,
      });
      return new Response(JSON.stringify({ ok: true, action, data }), {
        headers: { ...CORS, "content-type": "application/json" },
      });
    }

    // ── action: getReport（默认）──
    const advertiserId =
      body.advertiser_id ||
      Number(Deno.env.get("QIANCHUAN_ADVERTISER_ID")) ||
      0;
    if (!advertiserId) {
      return new Response(
        JSON.stringify({ ok: false, error: "缺少 advertiser_id" }),
        { status: 400, headers: { ...CORS, "content-type": "application/json" } },
      );
    }

    // 默认：拉取最近 7 天投放报表
    const endDate = body.end_date || formatDate(new Date());
    const startDate = body.start_date || formatDate(
      new Date(Date.now() - 7 * 86400_000),
    );

    const params: Record<string, unknown> = {
      advertiser_id: advertiserId,
      start_date: startDate,
      end_date: endDate,
      page: body.page || 1,
      page_size: body.page_size || 50,
      // 核心指标
      fields: body.fields ||
        '["stat_cost","show_cnt","click_cnt","ctr","convert_cnt","convert_rate","convert_cost","avg_show_cost","avg_click_cost","prepay_and_pay_order_roi","stat_datetime"]',
    };

    // 可选过滤
    if (body.campaign_ids) params.campaign_ids = body.campaign_ids;
    if (body.ad_ids) params.ad_ids = body.ad_ids;

    const data = await callQianchuan("/2/report/advertiser/get/", params);
    return new Response(JSON.stringify({
      ok: true,
      action,
      data,
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
});

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
