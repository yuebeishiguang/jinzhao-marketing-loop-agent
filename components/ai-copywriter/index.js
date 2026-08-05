// genMarketing —— AI 营销文案（老板端：菜品介绍 / 活动推广）
//
// 【环境变量配置】与 genPraise 完全相同（云开发控制台 → 云函数 genMarketing → 配置 → 环境变量）：
//   LLM_BASE_URL  例：https://api.moonshot.cn/v1
//   LLM_API_KEY   你的 Kimi API Key（sk-...，绝不写进代码）
//   LLM_MODEL     便宜模型即可，例：moonshot-v1-8k
//
// v2 知识增强：生成前读取本店最近 5 条真实好评作"顾客原声素材"，
// 要求文案化用真实口碑（知识增强生成）；platform 参数分平台风格：
//   moments 朋友圈（默认）/ xhs 小红书 / douyin 抖音口播 / dianping 点评店铺页介绍
// 合规红线：dianping 只做店铺页介绍/回复参考，绝不生成冒充顾客的假评价。
// 内容安全：所有输出（含兜底模板）过 msgSecCheck，命中违规返回 87014。
// 文案只生成给老板参考，老板自己复制去发，不与任何奖励动作挂钩。
const cloud = require('wx-server-sdk');
const https = require('https');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

async function assertOwner(shopId, OPENID) {
  const shop = await db.collection('shops').doc(shopId).get().catch(() => null);
  if (!shop || !shop.data) return null;
  return shop.data.ownerOpenid === OPENID ? shop.data : null;
}

/** 调 OpenAI 兼容的 chat/completions（非流式）——与 genPraise 同一套 */
function chatCompletion(messages, { maxTokens = 500, temperature = 0.8 } = {}) {
  const baseURL = (process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || '';
  const model = process.env.LLM_MODEL || 'kimi-k2.6';
  if (!baseURL || !apiKey) {
    return Promise.reject(new Error('LLM 未配置'));
  }
  const url = new URL(`${baseURL}/chat/completions`);
  // kimi-k2.5/k2.6 等新模型：temperature 固定不可传，thinking 默认开启需显式关闭（省钱省时）
  const bodyObj = { model, messages, max_tokens: maxTokens, stream: false };
  if (/^kimi-/.test(model)) {
    bodyObj.thinking = { type: 'disabled' };
  } else {
    bodyObj.temperature = temperature;
  }
  const body = JSON.stringify(bodyObj);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        timeout: 25000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Authorization: `Bearer ${apiKey}`
        }
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const text = json.choices && json.choices[0] && json.choices[0].message
              ? json.choices[0].message.content
              : '';
            if (!text) return reject(new Error('LLM 返回为空: ' + data.slice(0, 200)));
            resolve(text);
          } catch (e) {
            reject(new Error('LLM 返回解析失败'));
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('LLM 请求超时')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/** 知识增强：读本店最近真实好评作"顾客原声素材"（没有就给空，不影响生成） */
async function loadPraiseQuotes(shopId) {
  const res = await db.collection('feedbacks')
    .where({ shopId, rating: _.gte(4) })
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get()
    .catch(() => ({ data: [] }));
  return (res.data || [])
    .map((f) => String(f.content || '').trim())
    .filter((c) => c.length >= 8)
    .slice(0, 5)
    .map((c) => c.slice(0, 60));
}

const PLATFORMS = {
  moments: { name: '朋友圈', style: '直接能发朋友圈或顾客群，口语化，像老板自己说话' },
  xhs: { name: '小红书', style: '种草笔记口吻，真实体验感，带 2-3 个话题标签（#店名 #城市美食 这类）' },
  douyin: { name: '抖音口播', style: '口播脚本，短句分行，前 3 秒必须勾住人，适合对着镜头念' },
  dianping: { name: '点评店铺页', style: '店铺页介绍口吻，客观实在，介绍招牌和特色，绝不冒充顾客写假评价' }
};

/** 从 LLM 输出里解析文案（要求模型用 1. 2. 开头），每条限 200 字 */
function parseCopies(text) {
  const lines = text.split('\n')
    .map((l) => l.replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, '').trim())
    .filter((l) => l.length >= 10);
  return lines.slice(0, 2).map((l) => l.slice(0, 200));
}

/** LLM 不可用时的兜底模板（页面会标注"AI 忙，先参考"） */
function fallbackCopies(shopName, topic, kind) {
  const t = topic || (kind === 'dish' ? '招牌菜' : '店里活动');
  if (kind === 'dish') {
    return [
      `最近不少老客点名要吃咱家的${t}，都是当天现做，卖完就没了。想吃趁早来，扫码领券，到店就能用。`,
      `${shopName}的${t}，自己家里也常做给孩子吃，料放心、分量足。路过进来尝尝，扫码领券，到店就能用。`
    ];
  }
  return [
    `${shopName}这周有个小心意：${t}。街坊邻居都来转转，人多热闹，扫码领券，到店就能用。`,
    `跟大家说一声，${shopName}的${t}开始了，就这几天。带上家人朋友一起来，扫码领券，到店就能用。`
  ];
}

/** 每店每日 LLM 调用上限（成本保险丝）：超上限抛错走兜底模板，不挡业务流程 */
async function hitLlmCap(shopId, fnName, limit) {
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // 东八区
  const id = `${shopId}_${fnName}_${day}`;
  const coll = db.collection('llmUsage');
  const doc = await coll.doc(id).get().catch(() => null);
  const n = doc && doc.data ? doc.data.n || 0 : 0;
  if (n >= limit) return true;
  try {
    await coll.doc(id).update({ data: { n: _.inc(1) } });
  } catch (e) {
    await coll.add({ data: { _id: id, shopId, fn: fnName, day, n: 1 } }).catch(() => {});
  }
  return false;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { shopId } = event;
  const topic = String(event.topic || '').trim().slice(0, 30);
  const kind = event.kind === 'promo' ? 'promo' : 'dish';
  const platform = PLATFORMS[event.platform] ? event.platform : 'moments';
  if (!shopId) return { code: 400, msg: '参数不对' };

  const shop = await assertOwner(shopId, OPENID);
  if (!shop) return { code: 4003, msg: '只有老板能操作' };
  const shopName = shop.name;

  // 知识增强：顾客原声素材（真实好评原文）+ 平台话术手册（kb 读不到用内置兜底）
  const [quotes, copybook] = await Promise.all([
    loadPraiseQuotes(shopId),
    db.collection('kb').doc('platform-copybook').get().catch(() => null)
  ]);
  const kbStyles = copybook && copybook.data && copybook.data.data ? copybook.data.data : null;
  const styleText = (kbStyles && kbStyles[platform]) || PLATFORMS[platform].style;
  const quoteBlock = quotes.length
    ? `\n顾客原声素材（真实评价原文，文案里要化用其中至少一条）：\n${quotes.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
    : '';

  const kindDesc = kind === 'dish' ? '菜品介绍' : '活动推广';
  const prompt = [
    '你是县城一家小店的老板，正在给自己的店写宣传文案。',
    `店名：${shopName}`,
    `文案类型：${kindDesc}`,
    `发布平台：${PLATFORMS[platform].name}`,
    `主题：${topic || (kind === 'dish' ? '招牌菜' : '到店活动')}`,
    quoteBlock,
    '写 2 条文案，要求：',
    `1. 每条 200 字以内，${styleText}`,
    '2. 突出到店的理由：新鲜现做、街坊口碑、实惠、热闹这类实在卖点',
    '3. 别用"绝绝子""yyds""天花板"这类网络词，不夸张不虚假承诺',
    platform === 'moments' ? '4. 每条结尾固定带一句："扫码领券，到店就能用"' : '4. 结尾自然引导到店即可',
    '5. 只输出两条文案，分别以"1.""2."开头，不要任何其他内容'
  ].filter(Boolean).join('\n');

  let copies;
  let fallback = false;
  try {
    const cap = parseInt(process.env.LLM_DAILY_CAP || '30', 10);
    if (await hitLlmCap(shopId, 'genMarketing', cap)) throw new Error('今日生成次数用完');
    const text = await chatCompletion([{ role: 'user', content: prompt }], { maxTokens: 600, temperature: 0.85 });
    copies = parseCopies(text);
    if (!copies.length) throw new Error('解析不到文案');
  } catch (e) {
    console.warn('[genMarketing] LLM 失败，走兜底:', e.message);
    copies = fallbackCopies(shopName, topic, kind);
    fallback = true;
  }

  // —— 内容安全：输出过 msgSecCheck，命中违规返回 87014 ——
  // 安检服务本身异常不拦老板（文案老板自己会审），只记日志放行。
  try {
    for (const copy of copies) {
      await cloud.openapi.security.msgSecCheck({ content: copy });
    }
  } catch (e) {
    if (e.errCode === 87014) {
      return { code: 87014, msg: '生成的文案触到敏感词了，换个主题再试试' };
    }
    console.error('[genMarketing] msgSecCheck 异常（放行）:', e);
  }

  return { code: 0, copies, fallback, platform, quoted: quotes.length };
};
