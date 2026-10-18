import { db } from './db-infrastructure.js';
import { now } from './db-values.js';
import { DISH_SEEDS } from './meal-data.js';
import { KNOWLEDGE_SEEDS, PROJECT_SEEDS, RULE_SEEDS } from './catalog-data.js';

export async function seedStage13Catalog(ignoreClause) {
  const stamp = now();
  const projectInsert = `INSERT ${ignoreClause} INTO projects
    (id,slug,name,category,intensity,location,description,suitable_people,contraindications,
      open_windows_json,capacity_per_window,sea_entry,outdoor,activity_tag,active,is_demo,source_reference,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?)`;
  for (const project of PROJECT_SEEDS) {
    await db.prepare(projectInsert).run(
      project.id, project.slug, project.name, project.category, project.intensity,
      project.location, project.description, project.suitablePeople, project.contraindications,
      JSON.stringify({ demo: true, timezone: 'Asia/Shanghai', windows: project.openWindows }),
      project.capacityPerWindow, project.seaEntry ? 1 : 0, project.outdoor ? 1 : 0,
      project.activityTag, '项目依据/基于多智能体的海滨疗养智能康养服务系统.docx 表3；地点、说明补充、窗口与容量为演示数据。', stamp, stamp
    );
  }

  const knowledgeInsert = `INSERT ${ignoreClause} INTO domain_knowledge
    (knowledge_id,domain,title,summary,body,keywords_json,source_name,source_url,source_checked_at,active,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,1,?)`;
  for (const item of KNOWLEDGE_SEEDS) {
    await db.prepare(knowledgeInsert).run(
      item.id, item.domain, item.title, item.summary, item.body, JSON.stringify(item.keywords),
      item.sourceName, item.sourceUrl, stamp, stamp
    );
  }

  const ruleInsert = `INSERT ${ignoreClause} INTO safety_rules
    (rule_id,title,scope,trigger_condition,conditions_json,action,version,source_reference,source_url,demo_note,active,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,1,?)`;
  for (const rule of RULE_SEEDS) {
    await db.prepare(ruleInsert).run(
      rule.id, rule.title, rule.scope, rule.triggerCondition, JSON.stringify(rule.conditions),
      rule.action, rule.version, rule.sourceReference, rule.sourceUrl, rule.demoNote, stamp
    );
  }
}

export async function seedMealCatalog(ignoreClause) {
  for (const dish of DISH_SEEDS) {
    await db.prepare(`INSERT ${ignoreClause} INTO dishes
      (id,name,ingredients_json,allergens_json,dietary_tags_json,audience_tags_json,meal_types_json,slot,
       nutrition_labels_json,source_reference,supply_status,non_seafood_alternative_id,is_demo)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      dish.id, dish.name, JSON.stringify(dish.ingredients), JSON.stringify(dish.allergens),
      JSON.stringify(dish.dietaryTags), JSON.stringify(dish.audienceTags), JSON.stringify(dish.mealTypes),
      dish.slot, JSON.stringify(dish.nutritionLabels), dish.sourceReference, dish.supplyStatus,
      dish.nonSeafoodAlternativeId, dish.isDemo ? 1 : 0
    );
  }
}

export async function correctOlderAdultActivityKnowledgeSource() {
  const item = KNOWLEDGE_SEEDS.find(seed => seed.id === 'knowledge-exercise-02');
  if (!item) throw new Error('knowledge-exercise-02 seed is missing');
  const stamp = now();
  await db.prepare(`UPDATE domain_knowledge
    SET source_name=?,source_url=?,source_checked_at=?,updated_at=?
    WHERE knowledge_id=? AND source_name=? AND source_url=?`).run(
    item.sourceName, item.sourceUrl, stamp, stamp, item.id,
    'WHO Physical activity fact sheet',
    'https://www.who.int/news-room/fact-sheets/detail/physical-activity'
  );
}
