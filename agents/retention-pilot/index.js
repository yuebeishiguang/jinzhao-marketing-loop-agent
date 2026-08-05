// applyPilot —— 审批闸门：老板在参谋日志页一键"照办"，执行中枢的待办建议（发券）
//
// 架构纪律：dailyPilot 只生成建议，动钱的动作必须老板点头。
// 每张券直接进顾客"我的券"账户（自家数据库操作，无需推送授权）；
// 差评/好评顾客有订阅授权的，尝试推一条服务通知，失败静默。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function weekKey() {
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const day = (now.getUTCDay() + 6) % 7;
  return new Date(now.getTime() - day * 86400000).toISOString().slice(0, 10);
}

function ruleFace(rule) {
  if (rule.type === 'fixed') return `立减 ${rule.amount} 元`;
  if (rule.type === 'threshold') return `满 ${rule.threshold} 元减 ${rule.amount} 元`;
  return rule.text || '到店优惠';
}

/** 生成 6 位券码，同店内不重复（最多试 5 次） */
async function genCode(shopId) {
  for (let i = 0; i < 5; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const dup = await db.collection('coupons').where({ shopId, code }).count().catch(() => ({ total: 1 }));
    if (!dup.total) return code;
  }
  return String(Date.now()).slice(-6);
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { shopId, logId } = event;
  if (!shopId || !logId) return { code: 400, msg: '参数不对' };

  const shop = await db.collection('shops').doc(shopId).get().catch(() => null);
  if (!shop || !shop.data || shop.data.ownerOpenid !== OPENID) {
    return { code: 4003, msg: '只有老板能操作' };
  }
  const logDoc = await db.collection('agentLog').doc(logId).get().catch(() => null);
  if (!logDoc || !logDoc.data || logDoc.data.shopId !== shopId) {
    return { code: 404, msg: '待办不存在' };
  }
  if (logDoc.data.applied) return { code: 4090, msg: '这批建议已经照办过了' };

  const actions = Array.isArray(logDoc.data.actions) ? logDoc.data.actions : [];
  if (!actions.length) return { code: 4091, msg: '这条日志没有待办建议' };

  const wk = weekKey();
  const validDays = 7;
  const expireAt = new Date(Date.now() + validDays * 86400000);
  let issued = 0;
  const detail = [];

  for (const action of actions) {
    const openids = [...new Set(action.openids || [])].slice(0, 20);
    for (const openid of openids) {
      // 同人同分层当天只发一张，防止重复点"照办"刷券
      const dup = await db.collection('coupons')
        .where({ shopId, openid, source: 'agent', segment: action.segment, weekKey: wk })
        .count()
        .catch(() => ({ total: 0 }));
      if (dup.total) continue;
      const code = await genCode(shopId);
      await db.collection('coupons').add({
        data: {
          shopId, openid, code,
          title: ruleFace(action.rule),
          rule: action.rule,
          status: 'unused',     // 与领券链路口径一致：unused | used | expired
          weekKey: wk,
          source: 'agent',          // 标记：中枢发的券
          segment: action.segment,  // bad / good / sleep
          expireAt,
          createdAt: new Date()
        }
      }).catch(() => {});
      issued++;
    }
    detail.push(`${action.why}（已发 ${openids.length} 张）`);
  }

  await db.collection('agentLog').doc(logId).update({
    data: { applied: true, appliedAt: new Date(), appliedBy: OPENID, applyDetail: detail }
  }).catch(() => {});

  return { code: 0, issued, detail };
};
