const source = '海屿康养社区 Stage16 演示配方资料；食材、过敏原和标签仅为显式演示字段，不是营养检测或真实供货承诺。';
const demoLabels = ['演示配方标签；非营养检测结果'];

function dish(id, name, ingredients, allergens, tags, meals, slot, audienceTags = [], alternative = null) {
  return {
    id, name, ingredients, allergens, dietaryTags: tags, audienceTags, mealTypes: meals,
    slot, nutritionLabels: demoLabels, sourceReference: source, supplyStatus: 'demo_available',
    nonSeafoodAlternativeId: alternative, isDemo: true
  };
}

const mains = ['breakfast', 'lunch', 'dinner'];
const sides = ['breakfast', 'lunch', 'dinner'];
const soups = ['breakfast', 'lunch', 'dinner'];

export const DISH_SEEDS = [
  dish('dish-chicken-rice', '香菇鸡肉饭（演示）', ['鸡肉', '大米', '香菇', '姜'], [], ['清淡口味'], mains, 'main'),
  dish('dish-tofu-rice', '香菇豆腐饭（演示）', ['豆腐', '大米', '香菇', '姜'], ['soy'], ['素食', '清淡口味'], mains, 'main', ['清淡口味']),
  dish('dish-shrimp-noodles', '虾仁面（演示）', ['小麦面', '虾仁', '青菜'], ['shrimp', 'wheat'], [], ['breakfast', 'lunch'], 'main', [], 'dish-chicken-rice'),
  dish('dish-fish-rice', '清蒸鱼配米饭（演示）', ['鱼肉', '大米', '姜'], ['fish'], ['清淡口味'], ['lunch', 'dinner'], 'main', ['清淡口味'], 'dish-chicken-rice'),
  dish('dish-egg-custard', '鸡蛋羹配米饭（演示）', ['鸡蛋', '大米'], ['egg'], ['清淡口味'], mains, 'main', ['清淡口味']),
  dish('dish-pumpkin-congee', '南瓜粥（演示）', ['大米', '南瓜'], [], ['素食', '清淡口味'], ['breakfast'], 'main', ['清淡口味']),
  dish('dish-steamed-bun', '蔬菜馒头（演示）', ['小麦面', '青菜'], ['wheat'], ['素食'], ['breakfast'], 'main'),
  dish('dish-broccoli', '清炒西兰花（演示）', ['西兰花', '植物油'], [], ['素食', '清淡口味'], sides, 'side', ['清淡口味']),
  dish('dish-carrot', '胡萝卜炒西葫芦（演示）', ['胡萝卜', '西葫芦', '植物油'], [], ['素食', '清淡口味'], sides, 'side', ['清淡口味']),
  dish('dish-tofu-side', '香煎豆腐（演示）', ['豆腐', '植物油'], ['soy'], ['素食'], sides, 'side'),
  dish('dish-seaweed-soup', '紫菜蛋花汤（演示）', ['紫菜', '鸡蛋'], ['egg'], ['清淡口味'], soups, 'soup', ['清淡口味']),
  dish('dish-wintermelon-soup', '冬瓜汤（演示）', ['冬瓜', '姜'], [], ['素食', '清淡口味'], soups, 'soup', ['清淡口味']),
  dish('dish-fish-soup', '鱼片汤（演示）', ['鱼肉', '姜'], ['fish'], ['清淡口味'], ['lunch', 'dinner'], 'soup', ['清淡口味']),
  dish('dish-peanut-congee', '花生粥（演示）', ['大米', '花生'], ['peanut'], [], ['breakfast'], 'main'),
  dish('dish-milk-oats', '牛奶燕麦粥（演示）', ['燕麦', '牛奶'], ['milk', 'oats'], ['清淡口味'], ['breakfast'], 'main', ['清淡口味'])
];
