// reservation-perceive —— 预约感知 Skill：Agent 自主读取预约数据源
//
// 干什么：把"预约簿"变成 Agent 的感知器官——
//   · 今日/明日到店桌数、人数、包厢数
//   · 预约点菜榜 TOP3（备菜提醒的原料）
//   · 昨日爽约桌数（电话确认提醒的原料）
// 产出：结构化感知 + 规则化备菜提醒 + 推送压缩文案
//
// 设计纪律：
//   · 读不到（集合未建/查询异常）返回 null，调用方降级——绝不拖垮主控
//   · 纯规则聚合，不调 LLM
//   · 备菜提醒走规则生成：LLM 全挂，这句话也必须在
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function todayStr() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}
function dayStrOffset(offset) {
  return new Date(Date.now() + 8 * 3600 * 1000 + offset * 86400000).toISOString().slice(0, 10);
}

/**
 * 预约感知：读昨日~明日的预约单
 * @param {string} shopId
 * @returns {null|{today:{tables,people,box},tomorrow:{tables,people,box},topDishes:[{name,count}],noshowYesterday:number}}
 */
async function perceiveReservations(shopId) {
  const today = todayStr();
  const tomorrow = dayStrOffset(1);
  const yesterday = dayStrOffset(-1);
  const r = await db.collection('reservations')
    .where({ shopId, date: _.gte(yesterday).and(_.lte(tomorrow)) })
    .limit(100)
    .get()
    .catch(() => null);
  if (!r) return null;
  const all = r.data || [];
  const live = all.filter((x) => x.status === 'pending' || x.status === 'confirmed');
  const sumPeople = (arr) => arr.reduce((n, x) => n + (Number(x.people) || 0), 0);
  const boxCount = (arr) => arr.filter((x) => x.scene === 'box').length;
  const todayList = live.filter((x) => x.date === today);
  const tomorrowList = live.filter((x) => x.date === tomorrow);
  // 预约点菜榜：今日+明日被点最多的菜 TOP3
  const counter = {};
  live.forEach((x) => (x.dishes || []).forEach((d) => {
    const n = String((d && d.name) || '').trim();
    if (n) counter[n] = (counter[n] || 0) + 1;
  }));
  const topDishes = Object.entries(counter)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }));
  return {
    today: { tables: todayList.length, people: sumPeople(todayList), box: boxCount(todayList) },
    tomorrow: { tables: tomorrowList.length, people: sumPeople(tomorrowList), box: boxCount(tomorrowList) },
    topDishes,
    noshowYesterday: all.filter((x) => x.date === yesterday && x.status === 'noshow').length
  };
}

/** 备菜提醒（规则化生成，塞进建议第一条） */
function prepReminder(resv) {
  if (!resv || !resv.tomorrow.tables) return '';
  const t = resv.tomorrow;
  let s = `明日 ${t.tables} 桌预约共 ${t.people} 人` + (t.box ? `（含包厢 ${t.box} 桌）` : '');
  if (resv.topDishes.length) {
    const d = resv.topDishes[0];
    s += `，${d.count} 桌点了${d.name}，请提前备足`;
  }
  return s.slice(0, 60);
}

/** 推送压缩版（thing 字段约 20 字）：昨日爽约 > 明日预约 */
function resvPushText(resv) {
  if (!resv) return '';
  const t = resv.tomorrow.tables;
  const noshow = resv.noshowYesterday;
  if (noshow && t) return `昨${noshow}桌未到·明日${t}桌约`.slice(0, 20);
  if (t) return `明日${t}桌预约·点我看备菜`.slice(0, 20);
  if (noshow) return `昨日${noshow}桌未到·记得电话确认`.slice(0, 20);
  return '';
}

exports.main = async (event) => {
  const { shopId } = event || {};
  if (!shopId) return { code: 400, msg: '缺 shopId' };
  const resv = await perceiveReservations(shopId);
  return { code: 0, reservations: resv, reminder: prepReminder(resv), pushText: resvPushText(resv) };
};

module.exports.perceiveReservations = perceiveReservations;
module.exports.prepReminder = prepReminder;
module.exports.resvPushText = resvPushText;
