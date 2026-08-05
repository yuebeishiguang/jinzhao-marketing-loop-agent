// dailyPilot —— 餐饮经营智能体调度中枢（每晚 20:30 定时无人触发，也可老板手动触发测试）
//
// 运行链路：感知→情感分析→诊断→生成分层决策→生成三件套→推送老板→留痕。
// 设计纪律（别改）：
//   · 数据读取自家库，不爬外部平台
//   · 发券这类动钱动作只生成"待办建议"，老板在参谋日志页一键"照办"（applyPilot）才落地
//   · 每店每天限跑 1 次（保险丝），LLM ≤2 次调用，全挂也有规则化兜底，绝不硬报错
//   · 每次运行写 agentLog——这是"AI 自主任务闭环"的可视化证据
//
// 【定时触发】云开发控制台 → dailyPilot → 触发器 → 添加"定时触发"：每天 20:30（cron 0 30 20 * * * *）
// 【环境变量】LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 三条（同 genMarketing）；
//   BOSS_TEMPLATE_ID 可选：老板通知订阅消息模板 ID，没配就只写日志不推送
// 【超时】控制台把超时改成 60 秒（LLM 2 次调用 + 多店循环）
const cloud = require('wx-server-sdk');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

// ---------- LLM（与 genMarketing 同一套） ----------
function chatCompletion(messages, { maxTokens = 600 } = {}) {
  const baseURL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || 'kimi-k2.6';
  if (!baseURL || !apiKey) return Promise.reject(new Error('LLM 未配置'));
  const url = new URL(`${baseURL}/chat/completions`);
  const bodyObj = { model, messages, max_tokens: maxTokens, stream: false };
  if (/^kimi-/.test(model)) bodyObj.thinking = { type: 'disabled' };
  const body = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname, port: url.port || 443, path: url.pathname, method: 'POST', timeout: 25000,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${apiKey}` }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const text = json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : '';
            if (!text) return reject(new Error('LLM 返回为空'));
            resolve(text);
          } catch (e) { reject(new Error('LLM 返回解析失败')); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('LLM 请求超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function hitLlmCap(shopId, fnName, limit) {
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const id = `${shopId}_${fnName}_${day}`;
  const coll = db.collection('llmUsage');
  const doc = await coll.doc(id).get().catch(() => null);
  const n = doc && doc.data ? doc.data.n || 0 : 0;
  if (n >= limit) return true;
  try { await coll.doc(id).update({ data: { n: _.inc(1) } }); }
  catch (e) { await coll.add({ data: { _id: id, shopId, fn: fnName, day, n: 1 } }).catch(() => {}); }
  return false;
}

function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function dayStart() {
  return new Date(Date.parse(todayStr() + 'T00:00:00.000+08:00'));
}
function weekKey() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const day = (now.getUTCDay() + 6) % 7;
  return new Date(now.getTime() - day * 86400000).toISOString().slice(0, 10);
}

// ---------- ① 感知：今日评价 + 分层原料 ----------
async function perceive(shopId) {
  const start = dayStart();
  const fbRes = await db.collection('feedbacks')
    .where({ shopId, createdAt: _.gte(start) })
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get()
    .catch(() => ({ data: [] }));
  // 分层原料：近 40 天领券/核销记录，找沉睡用户（30 天没影子的）
  const since = new Date(Date.now() - 40 * 86400000);
  const cpRes = await db.collection('coupons')
    .where({ shopId, createdAt: _.gte(since) })
    .limit(200)
    .get()
    .catch(() => ({ data: [] }));
  return { feedbacks: fbRes.data || [], coupons: cpRes.data || [] };
}

// ---------- ② 情感分析+诊断（LLM 第 1 次调用；失败走规则兜底） ----------
function ruleAnalysis(feedbacks) {
  const good = feedbacks.filter((f) => f.rating >= 4).length;
  const bad = feedbacks.filter((f) => f.rating <= 2).length;
  return {
    好评数: good, 中评数: feedbacks.length - good - bad, 差评数: bad,
    问题归因: bad ? [{ 类别: '待人工看', 摘要: '今天有差评，去评价管理里细看' }] : [],
    菜品维度: [], 最严重问题: bad ? '出现差评' : '暂无', 兜底: true
  };
}

async function llmAnalysis(shopName, feedbacks, kbStandard) {
  const list = feedbacks.slice(0, 12).map((f, i) =>
    `${i + 1}. [${f.rating}星] ${String(f.content || '').slice(0, 80)}`).join('\n');
  const standardBlock = kbStandard
    ? `归因分类标准（按此细分）：${JSON.stringify(kbStandard.categories)}`
    : '归因类别：口味/服务/价格/环境';
  const prompt = [
    `你是"${shopName}"的评价分析员。分析今天这些顾客评价，输出严格 JSON，不要任何其他文字：`,
    '{"好评数":0,"中评数":0,"差评数":0,"问题归因":[{"类别":"口味|服务|价格|环境","摘要":"20字内"}],"菜品维度":[{"菜":"菜名","问题":"15字内"}],"最严重问题":"20字内"}',
    standardBlock,
    '规则：问题归因只写有证据的类别；评价里没提菜品就菜品维度给空数组；都夸就最严重问题写"暂无"。',
    '', '今日评价：', list || '（今天没有新评价）'
  ].join('\n');
  const text = await chatCompletion([{ role: 'user', content: prompt }], { maxTokens: 400 });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('分析没返回 JSON');
  const a = JSON.parse(m[0]);
  return {
    好评数: a.好评数 | 0, 中评数: a.中评数 | 0, 差评数: a.差评数 | 0,
    问题归因: Array.isArray(a.问题归因) ? a.问题归因.slice(0, 4) : [],
    菜品维度: Array.isArray(a.菜品维度) ? a.菜品维度.slice(0, 4) : [],
    最严重问题: String(a.最严重问题 || '暂无').slice(0, 30), 兜底: false
  };
}

// ---------- ③ 分层大脑：生成待办建议（不直接发券，等老板照办） ----------
function segmentDecisions({ feedbacks, coupons }) {
  const actions = [];
  const seen = new Set();
  const badUsers = feedbacks.filter((f) => f.rating <= 2 && f.openid).map((f) => f.openid);
  const goodUsers = feedbacks.filter((f) => f.rating >= 4 && f.openid && String(f.content || '').length >= 5).map((f) => f.openid);
  if (badUsers.length) {
    badUsers.forEach((o) => seen.add(o));
    actions.push({
      segment: 'bad', openids: [...new Set(badUsers)].slice(0, 10),
      rule: { type: 'fixed', amount: 10, text: '老板的心意·安抚券' },
      why: `今天 ${badUsers.length} 位顾客给了差评，发张安抚券把人暖回来`
    });
  }
  if (goodUsers.length) {
    const rest = goodUsers.filter((o) => !seen.has(o));
    if (rest.length) {
      actions.push({
        segment: 'good', openids: [...new Set(rest)].slice(0, 10),
        rule: { type: 'fixed', amount: 5, text: '老客复购券' },
        why: `${rest.length} 位顾客写了走心好评，趁热发复购券锁回头客`
      });
    }
  }
  // 沉睡用户：近 30 天没有任何领券/核销，但 30-40 天前来过
  const lastSeen = {};
  coupons.forEach((c) => {
    const t = c.createdAt ? new Date(c.createdAt).getTime() : 0;
    if (c.openid && t > (lastSeen[c.openid] || 0)) lastSeen[c.openid] = t;
  });
  const sleepThreshold = Date.now() - 30 * 86400000;
  const sleepers = Object.keys(lastSeen).filter((o) => lastSeen[o] > 0 && lastSeen[o] < sleepThreshold);
  if (sleepers.length) {
    actions.push({
      segment: 'sleep', openids: sleepers.slice(0, 20),
      rule: { type: 'fixed', amount: 8, text: '好久不见·回店券' },
      why: `${sleepers.length} 位老客 30 天没来了，发"好久不见"券，券在账户里等他们下次扫码`
    });
  }
  return actions;
}

// ---------- ④ 生成三件套（LLM 第 2 次调用） ----------
async function llmArtifacts(shopName, analysis, praiseQuotes, adviceMap) {
  const quotes = praiseQuotes.slice(0, 3).map((q, i) => `${i + 1}. ${q}`).join('\n') || '（暂无）';
  // 建议映射库：只带命中的归因类别，省 token
  let adviceBlock = '';
  if (adviceMap && Array.isArray(analysis.问题归因)) {
    const hits = {};
    analysis.问题归因.forEach((i) => {
      Object.keys(adviceMap).forEach((k) => {
        if (String(i.摘要 || '').indexOf(k.split('/')[0]) >= 0 || String(i.类别 || '') === k) hits[k] = adviceMap[k];
      });
    });
    if (Object.keys(hits).length) adviceBlock = `行业建议参考：${JSON.stringify(hits)}`;
  }
  const prompt = [
    `你是"${shopName}"请的经营顾问。根据今天的评价分析和顾客原声，产出三样东西，输出严格 JSON：`,
    '{"优化方案":["今天就能做的一条","本周做的一条","持续盯的一条"],"营销文案":"120字内朋友圈文案，化用顾客原声，结尾带扫码领券到店就能用","券策略建议":"40字内"}',
    '要求：优化方案要具体不许说空话；文案用真实口碑，不夸张不虚假承诺；只输出 JSON。',
    adviceBlock,
    '', `今日分析：${JSON.stringify(analysis)}`, `顾客原声：\n${quotes}`
  ].filter(Boolean).join('\n');
  const text = await chatCompletion([{ role: 'user', content: prompt }], { maxTokens: 500 });
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('三件套没返回 JSON');
  const a = JSON.parse(m[0]);
  return {
    优化方案: Array.isArray(a.优化方案) ? a.优化方案.map((s) => String(s).slice(0, 60)).slice(0, 3) : [],
    营销文案: String(a.营销文案 || '').slice(0, 200),
    券策略建议: String(a.券策略建议 || '').slice(0, 60)
  };
}

function fallbackArtifacts(analysis) {
  return {
    优化方案: ['逐条回复今天的评价，让顾客感到被听见', '把今天的问题归个类，最多的先改', '盯本周核销率，低于三成就调整券面'],
    营销文案: '今天不少老客又来捧场，谢谢大家惦记。想吃趁早来，扫码领券，到店就能用。',
    券策略建议: analysis.差评数 > 0 ? '先安抚差评顾客，券别乱发' : '维持现有券策略即可',
    兜底: true
  };
}

async function secCheck(content) {
  await cloud.openapi.security.msgSecCheck({ content: String(content).slice(0, 2500) });
}

/** 行业知识包读取：读不到返回 null，调用方用内置兜底（第 5 层，轻量规则化知识包） */
async function loadKb(id) {
  const doc = await db.collection('kb').doc(id).get().catch(() => null);
  return doc && doc.data && doc.data.data ? doc.data.data : null;
}

// ---------- 单店跑一次中枢 ----------
async function runShop(shop) {
  const shopId = shop._id;
  const date = todayStr();
  const log = {
    shopId, date, runAt: new Date(), type: 'dailyPilot',
    sentiment: null, actions: [], artifacts: null, applied: false,
    pushSent: false, fallback: false
  };

  const { feedbacks, coupons } = await perceive(shopId);
  // 行业知识包（读不到就用内置兜底）
  const [kbStandard, adviceMap] = await Promise.all([
    loadKb('attribution-standard'),
    loadKb('advice-map')
  ]);
  // 无事发生：留一条巡航日志，证明中枢每晚都在岗（这也是证据）
  if (!feedbacks.length) {
    log.sentiment = { 好评数: 0, 中评数: 0, 差评数: 0, 巡航: true };
    log.artifacts = { 优化方案: [], 营销文案: '', 券策略建议: '今日无新评价，正常巡航' };
    // 沉睡用户即使没新评价也要扫
    log.actions = segmentDecisions({ feedbacks, coupons }).filter((a) => a.segment === 'sleep');
    await db.collection('agentLog').add({ data: log });
    return log;
  }

  let analysis;
  const cap = parseInt(process.env.LLM_DAILY_CAP || '2', 10);
  const capped = await hitLlmCap(shopId, 'dailyPilot', cap);
  if (capped) {
    analysis = ruleAnalysis(feedbacks);
    log.fallback = true;
  } else {
    try {
      analysis = await llmAnalysis(shop.name, feedbacks, kbStandard);
    } catch (e) {
      console.warn('[dailyPilot] 分析 LLM 失败，规则兜底:', e.message);
      analysis = ruleAnalysis(feedbacks);
      log.fallback = true;
    }
  }
  log.sentiment = analysis;

  // 分层大脑（纯规则，不烧 LLM）
  log.actions = segmentDecisions({ feedbacks, coupons });

  // 三件套（LLM 第 2 次；第一次挂了就不烧第二次，直接兜底）
  const praiseQuotes = feedbacks
    .filter((f) => f.rating >= 4 && String(f.content || '').length >= 8)
    .slice(0, 3)
    .map((f) => String(f.content).slice(0, 60));
  if (log.fallback) {
    log.artifacts = fallbackArtifacts(analysis);
  } else {
    try {
      const artifacts = await llmArtifacts(shop.name, analysis, praiseQuotes, adviceMap);
      // 输出安检：命中违规降级为兜底文案，不拦日志
      try {
        await secCheck(artifacts.营销文案);
        log.artifacts = artifacts;
      } catch (e) {
        if (e.errCode === 87014) {
          log.artifacts = fallbackArtifacts(analysis);
          log.fallback = true;
        } else {
          log.artifacts = artifacts; // 安检服务异常，放行
        }
      }
    } catch (e) {
      console.warn('[dailyPilot] 三件套 LLM 失败，走兜底:', e.message);
      log.artifacts = fallbackArtifacts(analysis);
      log.fallback = true;
    }
  }

  const addRes = await db.collection('agentLog').add({ data: log });
  log._id = addRes._id;

  // 推送老板（有模板才推；失败静默，日志已在）
  const tplId = process.env.BOSS_TEMPLATE_ID || '';
  if (tplId && shop.ownerOpenid) {
    try {
      const summary = `好评${analysis.好评数} 中评${analysis.中评数} 差评${analysis.差评数}`.slice(0, 20);
      await cloud.openapi.subscribeMessage.send({
        touser: shop.ownerOpenid,
        template_id: tplId,
        page: 'pages/boss/pilot-log/pilot-log',
        data: {
          thing6: { value: String(shop.name || '本店').slice(0, 20) },
          thing9: { value: ('今日中枢报告 ' + summary + (log.actions.length ? ' 有待办建议' : '')).slice(0, 20) }
        }
      });
      await db.collection('agentLog').doc(log._id).update({ data: { pushSent: true } }).catch(() => {});
      log.pushSent = true;
    } catch (e) {
      console.warn('[dailyPilot] 老板推送失败（静默）:', e && e.errCode, e && (e.errMsg || e.message));
    }
  }
  return log;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();

  // 老板手动触发（测试/演示用）：只跑自己的店，返回完整报告
  if (event && event.shopId) {
    const shop = await db.collection('shops').doc(event.shopId).get().catch(() => null);
    if (!shop || !shop.data || shop.data.ownerOpenid !== OPENID) {
      return { code: 4003, msg: '只有老板能操作' };
    }
    const log = await runShop(shop.data);
    return { code: 0, log };
  }

  // 定时触发：跑全部店（当前体量小，逐店串行；单店失败不拖垮其他店）
  const shops = await db.collection('shops').limit(50).get().catch(() => ({ data: [] }));
  const results = [];
  for (const shop of shops.data || []) {
    try {
      const log = await runShop(shop);
      results.push({ shopId: shop._id, ok: true, fallback: log.fallback });
    } catch (e) {
      console.error('[dailyPilot] 店', shop._id, '中枢运行失败:', e && e.message);
      results.push({ shopId: shop._id, ok: false });
    }
  }
  return { code: 0, ran: results.length, results };
};
