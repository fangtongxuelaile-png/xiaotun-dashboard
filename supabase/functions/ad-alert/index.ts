// Supabase Edge Function: ad-alert
// 支持日报 / 周报 / 月报，通过 body.type 区分
// 请求体：{ "type": "daily" | "weekly" | "monthly" }  默认 "daily"
//
// 必须配置的 Supabase Secrets：
//   DING_WEBHOOK  钉钉机器人 webhook 完整 URL
//   DING_SECRET   加签密钥（SEC开头，未开启加签则留空）
//
// 可选阈值 Secrets（不设则用括号内默认值）：
//   ALERT_ROI_MIN        ROI告警下限（默认 1.5）
//   ALERT_SPEND_CHANGE   消耗涨跌幅%触发告警（默认 40）
//   ALERT_ZERO_CONV_YUAN 有消耗无订单的最低消耗阈值，元（默认 300）

const PERF_IDS = ["1849923428895756", "1865614489935235"];
const CAOSHU_ID = "1850542911176195";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

// ─── 日期工具 ────────────────────────────────────────────────

function toStr(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** 当前 CST 时间（UTC+8）*/
function cstNow() {
  return new Date(Date.now() + 8 * 3_600_000);
}

function addDays(d: Date, n: number) {
  const r = new Date(d);
  r.setUTCDate(r.getUTCDate() + n);
  return r;
}

interface DateRange {
  start: string;
  end: string;
  label: string;       // 显示在消息标题里的时间描述
  prevStart: string;   // 对比期开始（用于周/月趋势对比）
  prevEnd: string;
}

function dailyRange(): DateRange {
  const today = cstNow();
  const yd = addDays(today, -1);
  const ydStr = toStr(yd);
  // 对比：前天
  const ydyd = addDays(today, -2);
  return { start: ydStr, end: ydStr, label: ydStr, prevStart: toStr(ydyd), prevEnd: toStr(ydyd) };
}

function weeklyRange(): DateRange {
  // 本周截至昨日：找到昨天所在周的周一，到昨天
  const today = cstNow();
  const yesterday = addDays(today, -1);
  const ydDay = yesterday.getUTCDay(); // 0=周日,1=周一,...,6=周六
  const daysToMon = ydDay === 0 ? 6 : ydDay - 1;
  const weekStart = addDays(yesterday, -daysToMon);
  // 对比：上周同等天数
  const prevWeekStart = addDays(weekStart, -7);
  const prevWeekEnd   = addDays(yesterday, -7);
  const label = `本周截至 ${toStr(yesterday).slice(5)}（${toStr(weekStart).slice(5)} 起）`;
  return {
    start: toStr(weekStart), end: toStr(yesterday), label,
    prevStart: toStr(prevWeekStart), prevEnd: toStr(prevWeekEnd),
  };
}

function monthlyRange(): DateRange {
  // 本月截至昨日：本月1日到昨天
  const today = cstNow();
  const yesterday = addDays(today, -1);
  const monthStart = new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), 1));
  // 对比：上月同等天数（1日到上月相同日期）
  const prevMonthLastDay = addDays(monthStart, -1);
  const prevMonthStart   = new Date(Date.UTC(prevMonthLastDay.getUTCFullYear(), prevMonthLastDay.getUTCMonth(), 1));
  const dayOfMonth = yesterday.getUTCDate();
  const prevMonthSameDay = new Date(Date.UTC(prevMonthLastDay.getUTCFullYear(), prevMonthLastDay.getUTCMonth(), dayOfMonth));
  const prevEnd = prevMonthSameDay > prevMonthLastDay ? prevMonthLastDay : prevMonthSameDay;
  const year  = yesterday.getUTCFullYear();
  const month = yesterday.getUTCMonth() + 1;
  const label = `${year}年${month}月截至 ${dayOfMonth}日`;
  return {
    start: toStr(monthStart), end: toStr(yesterday), label,
    prevStart: toStr(prevMonthStart), prevEnd: toStr(prevEnd),
  };
}

// ─── 数据结构 ────────────────────────────────────────────────

interface DayMetrics {
  cost: number; orders: number; gmv: number;
  roi: number; roiDays: number;
  a3: number; show: number; click: number;
}

function emptyDay(): DayMetrics {
  return { cost: 0, orders: 0, gmv: 0, roi: 0, roiDays: 0, a3: 0, show: 0, click: 0 };
}

function addMetrics(a: DayMetrics, b: DayMetrics): DayMetrics {
  return {
    cost:    a.cost + b.cost,
    orders:  a.orders + b.orders,
    gmv:     a.gmv + b.gmv,
    roi:     a.roi + b.roi,
    roiDays: a.roiDays + b.roiDays,
    a3:      a.a3 + b.a3,
    show:    a.show + b.show,
    click:   a.click + b.click,
  };
}

/** 汇总 dayMap 中指定日期范围内的所有数据 */
function sumRange(
  dayMap: Record<string, DayMetrics>,
  start: string,
  end: string,
): DayMetrics {
  return Object.entries(dayMap)
    .filter(([d]) => d >= start && d <= end)
    .reduce((acc, [, v]) => addMetrics(acc, v), emptyDay());
}

// ─── API 调用 ────────────────────────────────────────────────

async function fetchReport(
  ids: string[],
  startDate: string,
  endDate: string,
): Promise<Record<string, DayMetrics>> {
  const proxyUrl = `${Deno.env.get("SUPABASE_URL")}/functions/v1/juliangad-proxy`;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";

  const results = await Promise.all(
    ids.map((id) =>
      fetch(proxyUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${anonKey}`,
        },
        body: JSON.stringify({
          action: "getReport",
          advertiser_id: Number(id),
          start_date: startDate,
          end_date: endDate,
        }),
      }).then((r) => r.json()),
    ),
  );

  const dayMap: Record<string, DayMetrics> = {};
  results.forEach((res) => {
    const rows: any[] = res?.data?.data?.rows || [];
    rows.forEach((row) => {
      const day: string = row.dimensions?.stat_time_day;
      if (!day) return;
      if (!dayMap[day]) dayMap[day] = emptyDay();
      const m = row.metrics;
      dayMap[day].cost    += Math.round(Number(m.cost || 0) / 100_000 * 100) / 100;
      dayMap[day].orders  += Number(m.in_app_order_count || 0);
      dayMap[day].gmv     += Math.round(Number(m.in_app_order_gmv || 0) * 100) / 100;
      dayMap[day].a3      += Number(m.convert_cnt || 0);
      dayMap[day].show    += Number(m.show_cnt || 0);
      dayMap[day].click   += Number(m.click_cnt || 0);
      const roi = Number(m.in_app_order_roi || 0);
      if (roi > 0) { dayMap[day].roi += roi; dayMap[day].roiDays++; }
    });
  });

  return dayMap;
}

// ─── 钉钉推送 ────────────────────────────────────────────────

async function dingSign(secret: string, ts: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${ts}\n${secret}`));
  return encodeURIComponent(btoa(String.fromCharCode(...new Uint8Array(sig))));
}

async function sendDingTalk(content: string): Promise<{ ok: boolean; raw?: unknown }> {
  const webhook = Deno.env.get("DING_WEBHOOK");
  const secret  = Deno.env.get("DING_SECRET") || "";
  if (!webhook) return { ok: false, raw: "DING_WEBHOOK 未配置" };

  let url = webhook;
  if (secret) {
    const ts = Date.now();
    url += `&timestamp=${ts}&sign=${await dingSign(secret, ts)}`;
  }
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msgtype: "text", text: { content } }),
  });
  const data = await r.json();
  return { ok: data.errcode === 0, raw: data };
}

// ─── 异常检测（仅日报使用） ──────────────────────────────────

function checkAnomalies(
  yd: DayMetrics,
  ydRoi: number,
  avgCost: number,
): string[] {
  const roiMin        = Number(Deno.env.get("ALERT_ROI_MIN")        || "1.5");
  const spendChangePct= Number(Deno.env.get("ALERT_SPEND_CHANGE")   || "40");
  const zeroConvYuan  = Number(Deno.env.get("ALERT_ZERO_CONV_YUAN") || "300");

  if (yd.cost === 0) return ["🚨 效果账户昨日消耗为0，疑似停投或余额不足"];

  const warnings: string[] = [];

  if (ydRoi > 0 && ydRoi < roiMin) {
    warnings.push(`⚠️ ROI偏低：${ydRoi.toFixed(2)}（目标≥${roiMin}）`);
  }
  if (avgCost > 0) {
    const pct = (yd.cost - avgCost) / avgCost * 100;
    if (pct < -spendChangePct) {
      warnings.push(`⚠️ 消耗骤降 ${Math.abs(pct).toFixed(0)}%（昨¥${yd.cost} vs 近6日均¥${avgCost.toFixed(0)}）`);
    } else if (pct > spendChangePct) {
      warnings.push(`⚠️ 消耗骤增 ${pct.toFixed(0)}%（昨¥${yd.cost} vs 近6日均¥${avgCost.toFixed(0)}）`);
    }
  }
  if (yd.cost >= zeroConvYuan && yd.orders === 0) {
    warnings.push(`⚠️ 有消耗无转化：消耗¥${yd.cost}，订单0`);
  }
  return warnings;
}

// ─── 消息格式化 ──────────────────────────────────────────────

function fmtRoi(d: DayMetrics): string {
  if (d.roiDays === 0) return "暂无";
  const roi    = d.roi / d.roiDays;
  const roiMin = Number(Deno.env.get("ALERT_ROI_MIN") || "1.5");
  return `${roi.toFixed(2)}${roi >= roiMin ? " ✅" : " ⚠️"}`;
}

function fmtCtr(d: DayMetrics): string {
  return d.show > 0 ? (d.click / d.show * 100).toFixed(2) + "%" : "-";
}

function fmtTrend(cur: number, prev: number): string {
  if (prev === 0) return "";
  const pct = ((cur - prev) / prev * 100);
  const arrow = pct >= 0 ? "↑" : "↓";
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%${arrow}`;
}

function buildDailyMsg(range: DateRange, perf: DayMetrics, caoshu: DayMetrics, anomalies: string[]): string {
  const roi     = perf.roiDays > 0 ? perf.roi / perf.roiDays : 0;
  const a3Cost  = caoshu.a3 > 0 ? `¥${(caoshu.cost / caoshu.a3).toFixed(2)}` : "-";

  const lines = [
    `📊 小豚当家 · 投放日报`,
    `日期：${range.label}`,
    `━━━━━━━━━━━━━━━━`,
    `【效果账户 昨日】`,
    `消耗：¥${perf.cost.toFixed(2)}　订单：${perf.orders}　GMV：¥${perf.gmv.toFixed(2)}`,
    `ROI：${fmtRoi(perf)}　CTR：${fmtCtr(perf)}`,
    ``,
    `【种草通账户 昨日】`,
    `消耗：¥${caoshu.cost.toFixed(2)}　A3转化：${caoshu.a3}　单次成本：${a3Cost}`,
    `━━━━━━━━━━━━━━━━`,
  ];

  if (anomalies.length > 0) {
    lines.push("【异常提醒】", ...anomalies, "", "→ 请前往巨量引擎后台检查", "https://ad.oceanengine.com/");
  } else {
    lines.push("✅ 各项指标正常，继续加油！");
  }
  return lines.join("\n");
}

function buildWeeklyMsg(range: DateRange, perf: DayMetrics, caoshu: DayMetrics, prevPerf: DayMetrics): string {
  const a3Cost = caoshu.a3 > 0 ? `¥${(caoshu.cost / caoshu.a3).toFixed(2)}` : "-";

  const costTrend = fmtTrend(perf.cost, prevPerf.cost);
  const gmvTrend  = fmtTrend(perf.gmv,  prevPerf.gmv);
  const ordTrend  = fmtTrend(perf.orders, prevPerf.orders);
  const curRoi    = perf.roiDays > 0 ? perf.roi / perf.roiDays : 0;
  const prevRoi   = prevPerf.roiDays > 0 ? prevPerf.roi / prevPerf.roiDays : 0;
  const roiDiff   = curRoi > 0 && prevRoi > 0
    ? `${curRoi >= prevRoi ? "+" : ""}${(curRoi - prevRoi).toFixed(2)}`
    : "-";

  return [
    `📊 小豚当家 · 投放周报`,
    `周期：${range.label}`,
    `━━━━━━━━━━━━━━━━`,
    `【效果账户 本周汇总】`,
    `总消耗：¥${perf.cost.toFixed(2)}　总订单：${perf.orders}`,
    `总GMV：¥${perf.gmv.toFixed(2)}　平均ROI：${fmtRoi(perf)}`,
    `平均CTR：${fmtCtr(perf)}`,
    ``,
    `【种草通账户 本周汇总】`,
    `总消耗：¥${caoshu.cost.toFixed(2)}　A3总转化：${caoshu.a3}`,
    `A3平均成本：${a3Cost}`,
    `━━━━━━━━━━━━━━━━`,
    `【对比上上周】`,
    `消耗 ${costTrend || "-"}　GMV ${gmvTrend || "-"}　订单 ${ordTrend || "-"}　ROI ${roiDiff}`,
    `━━━━━━━━━━━━━━━━`,
    prevPerf.cost === 0 ? "（上上周暂无数据）" : (perf.gmv >= prevPerf.gmv ? "✅ 本周GMV高于上上周" : "⚠️ 本周GMV低于上上周，留意趋势"),
  ].join("\n");
}

function buildMonthlyMsg(range: DateRange, perf: DayMetrics, caoshu: DayMetrics, prevPerf: DayMetrics): string {
  const a3Cost = caoshu.a3 > 0 ? `¥${(caoshu.cost / caoshu.a3).toFixed(2)}` : "-";

  const costTrend = fmtTrend(perf.cost,   prevPerf.cost);
  const gmvTrend  = fmtTrend(perf.gmv,    prevPerf.gmv);
  const ordTrend  = fmtTrend(perf.orders, prevPerf.orders);

  return [
    `📊 小豚当家 · 投放月报`,
    `月份：${range.label}`,
    `━━━━━━━━━━━━━━━━`,
    `【效果账户 本月汇总】`,
    `总消耗：¥${perf.cost.toFixed(2)}　总订单：${perf.orders}`,
    `总GMV：¥${perf.gmv.toFixed(2)}　平均ROI：${fmtRoi(perf)}`,
    ``,
    `【种草通账户 本月汇总】`,
    `总消耗：¥${caoshu.cost.toFixed(2)}　A3总转化：${caoshu.a3}`,
    `A3平均成本：${a3Cost}`,
    `━━━━━━━━━━━━━━━━`,
    `【对比上上月】`,
    `消耗 ${costTrend || "-"}　GMV ${gmvTrend || "-"}　订单 ${ordTrend || "-"}`,
    `━━━━━━━━━━━━━━━━`,
    prevPerf.cost === 0 ? "（上上月暂无数据）" : (perf.gmv >= prevPerf.gmv ? "✅ 本月GMV高于上上月" : "⚠️ 本月GMV低于上上月"),
  ].join("\n");
}

// ─── 主入口 ──────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* 空 body 忽略 */ }

    const type = String(body.type || "daily");

    let range: DateRange;
    if      (type === "weekly")  range = weeklyRange();
    else if (type === "monthly") range = monthlyRange();
    else                         range = dailyRange();

    // 拉取当前期+对比期数据（并行）
    // 取较早的开始日期，一次请求覆盖两个周期
    const fetchStart = range.prevStart < range.start ? range.prevStart : range.start;
    const fetchEnd   = range.end;

    const [perfMap, caoshuMap] = await Promise.all([
      fetchReport(PERF_IDS,    fetchStart, fetchEnd),
      fetchReport([CAOSHU_ID], fetchStart, fetchEnd),
    ]);

    const perf      = sumRange(perfMap,    range.start,     range.end);
    const prevPerf  = sumRange(perfMap,    range.prevStart, range.prevEnd);
    const caoshu    = sumRange(caoshuMap,  range.start,     range.end);

    let content: string;

    if (type === "weekly") {
      content = buildWeeklyMsg(range, perf, caoshu, prevPerf);
    } else if (type === "monthly") {
      content = buildMonthlyMsg(range, perf, caoshu, prevPerf);
    } else {
      // 日报：还需计算近6日均值用于异常检测
      const yesterday = range.start;
      const prevCosts = Object.entries(perfMap)
        .filter(([d]) => d < yesterday)
        .map(([, v]) => v.cost);
      const avgCost = prevCosts.length > 0
        ? prevCosts.reduce((s, v) => s + v, 0) / prevCosts.length : 0;
      const ydRoi = perf.roiDays > 0 ? perf.roi / perf.roiDays : 0;
      const anomalies = checkAnomalies(perf, ydRoi, avgCost);
      content = buildDailyMsg(range, perf, caoshu, anomalies);
    }

    const result = await sendDingTalk(content);

    return new Response(
      JSON.stringify({ ok: result.ok, type, content, ding: result.raw }),
      { headers: { ...CORS, "content-type": "application/json" } },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String(e) }),
      { status: 500, headers: { ...CORS, "content-type": "application/json" } },
    );
  }
});
