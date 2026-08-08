// effect-review —— 效果复盘 Skill：Agent 自我验证昨天派的活儿
//
// 干什么：每天跑新任务前，先聚合"昨日策略执行效果"——
//   · 昨日新发的券，到现在核销了几张（核销率）
//   · 昨日的差评顾客，今天有没有追加投诉 / 回访转好评
// 产出：结构化复盘 + 一句人话复盘行（可直接塞进当日经营建议第一条）
//
// 设计纪律：
//   · 纯规则聚合，不调 LLM、零成本、可每晚全量跑
//   · 任何一步读不到数据就降级为空复盘，绝不拖垮主流程
//   · 只读不写——复盘结论由调用方决定怎么用（进建议 / 进日志 / 进推送）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function dayStart() {
  return new Date(Date.parse(todayStr() + 'T00:00:00.000+08:00'));
}

/**
 * 昨日效果复盘
 * @param {string} shopId 门店 ID
 * @param {object} [opts]
 * @param {Array}  [opts.coupons] 已拉好的近 40 天券（不传则本函数自查昨日新发）
 * @param {Array}  [opts.todayFeedbacks] 今日评价（用于判定差评顾客今日动向；不传则无法判定追加投诉）
 * @returns {{issued:number,redeemed:number,rate:number,badCount:number,followBad:number,followGood:number,text:string}}
 */
async function yesterdayReview(shopId, opts = {}) {
  const end = dayStart().getTime();
  const start = end - 86400000;

  // 昨日新发券：优先用调用方已拉好的券列表过滤，没有就自查
  let issuedArr;
  if (Array.isArray(opts.coupons)) {
    issuedArr = opts.coupons.filter((c) => {
      const t = c.createdAt ? new Date(c.createdAt).getTime() : 0;
      return t >= start && t < end;
    });
  } else {
    const r = await db.collection('coupons')
      .where({ shopId, createdAt: _.gte(new Date(start)).and(_.lt(new Date(end))) })
      .limit(200)
      .get()
      .catch(() => ({ data: [] }));
    issuedArr = r.data || [];
  }
  const issued = issuedArr.length;
  const redeemed = issuedArr.filter((c) => c.status === 'used').length;
  const rate = issued ? Math.round((redeemed / issued) * 100) : 0;

  // 昨日差评 + 这些顾客今天的动向
  const badRes = await db.collection('feedbacks')
    .where({ shopId, rating: _.lte(2), createdAt: _.gte(new Date(start)).and(_.lt(new Date(end))) })
    .limit(50)
    .get()
    .catch(() => ({ data: [] }));
  const badList = badRes.data || [];
  const badOpenids = new Set(badList.map((f) => f.openid).filter(Boolean));
  const todayFb = Array.isArray(opts.todayFeedbacks) ? opts.todayFeedbacks : [];
  const followBad = todayFb.filter((f) => f.openid && badOpenids.has(f.openid) && f.rating <= 2).length;
  const followGood = todayFb.filter((f) => f.openid && badOpenids.has(f.openid) && f.rating >= 4).length;

  // 拼人话（昨日没发券也没差评 → 空复盘，不硬凑一行）
  const parts = [];
  if (issued) parts.push(`发券${issued}张·已核销${redeemed}张(${rate}%)`);
  if (badList.length) {
    let s = `差评${badList.length}条`;
    if (followBad) s += `·追加投诉${followBad}条`;
    else if (followGood) s += `·${followGood}人回访转好评`;
    else s += '·顾客未追加投诉';
    parts.push(s);
  }
  const text = parts.length ? `昨日复盘：${parts.join('；')}` : '';
  return { issued, redeemed, rate, badCount: badList.length, followBad, followGood, text };
}

/** 复盘行塞进建议第一条（前端零改动即可显示） */
function injectReview(artifacts, rev) {
  if (!artifacts || !rev || !rev.text) return artifacts;
  artifacts.优化方案 = [rev.text, ...(artifacts.优化方案 || [])].slice(0, 4);
  return artifacts;
}

/** 推送压缩版（订阅消息 thing 字段约 20 字限制） */
function reviewPushText(rev) {
  if (!rev || !rev.issued) return '';
  return `昨发${rev.issued}券·核销${rev.rate}%`.slice(0, 20);
}

// 云函数入口：读参返回复盘（也可把上面三个函数直接搬进你的主控函数里）
exports.main = async (event) => {
  const { shopId } = event || {};
  if (!shopId) return { code: 400, msg: '缺 shopId' };
  const rev = await yesterdayReview(shopId, event);
  return { code: 0, review: rev, pushText: reviewPushText(rev) };
};

// 作为主控内嵌模块使用时：module.exports = { yesterdayReview, injectReview, reviewPushText }
module.exports.yesterdayReview = yesterdayReview;
module.exports.injectReview = injectReview;
module.exports.reviewPushText = reviewPushText;
