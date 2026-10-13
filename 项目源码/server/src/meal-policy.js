export const MEAL_RECOMMENDATION_POLICY = Object.freeze({
  version: 'catalog_rotation_v1', method: 'catalog_rules', label: '目录规则推荐',
  description: '先核供应、餐次、餐位与记录限制；早餐优先专用菜，当日优先不重复，按业务日期轮换。保存后不重排；未提交订单不代表点餐。'
});

// The caller supplies only candidates already filtered by all current restrictions.
export function chooseMenuDish({ eligible, usedIds, businessDate, mealType, slot }) {
  const fresh = eligible.filter(dish => !usedIds.has(dish.id));
  let pool = fresh.length ? fresh : eligible;
  const breakfastOnly = mealType === 'breakfast'
    ? pool.filter(dish => dish.mealTypes.length === 1 && dish.mealTypes[0] === 'breakfast') : [];
  if (breakfastOnly.length) pool = breakfastOnly;
  if (!pool.length) return null;
  const day = Math.floor(Date.parse(`${businessDate}T00:00:00Z`) / 86400000);
  const dish = pool[((day % pool.length) + pool.length) % pool.length];
  const meal = ({ breakfast: '早餐', lunch: '午餐', dinner: '晚餐' })[mealType];
  const position = ({ main: '主食', side: '配菜', soup: '汤品' })[slot];
  return { dish, reason: `目录规则推荐：按生成时记录限制筛选（未回答不视为无）；适用${meal}的${position}，合规候选${eligible.length}种。${breakfastOnly.length ? '优先早餐专用菜；' : ''}${fresh.length ? '当日此餐位优先不重复；' : '当日合规候选不足，允许重复；'}偏好标签参与排序，按业务日期轮换。演示供货不是实际库存承诺。` };
}

export function mealDeliveryTiming(businessDate, mealType, legacyRecordedAt = null) {
  const hour = ({ breakfast: 8, lunch: 12, dinner: 18 })[mealType];
  const [year, month, day] = businessDate.split('-').map(Number);
  const regularServingAt = new Date(Date.UTC(year, month - 1, day, hour - 8)).toISOString();
  return {
    regularServingAt, expectedDeliveryAt: null, deliveryEstimateStatus: 'unknown',
    expectedDeliveryNote: '预计送达时间未确定；常规供餐时刻不是预计送达，请查看实际备餐与送达状态。',
    ...(legacyRecordedAt ? { legacyRecordedServingAt: legacyRecordedAt } : {})
  };
}
