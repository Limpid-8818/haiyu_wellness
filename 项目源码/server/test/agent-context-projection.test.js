import test from 'node:test';
import assert from 'node:assert/strict';
import { modelToolReply } from '../src/agent-context-projection.js';

test('domain projection keeps full safety evidence while omitting duplicated source labels only from model input', () => {
  const item={status:'completed',data:{evaluations:[{projectId:'sea',outcome:'rejected',matchedRules:[{reason:'未批准下海'}]}]},sources:[{id:'rule-sea',label:'重复安全规则标签'}]};
  const projected=modelToolReply('domain.physio',item);
  assert.equal(projected.data,item.data);
  assert.equal(projected.data.evaluations[0].matchedRules[0].reason,'未批准下海');
  assert.equal(projected.sources,undefined);
  assert.equal(item.sources[0].id,'rule-sea');
});

test('nutrition model context deduplicates dish objects while preserving meal options, allergy exclusions, and knowledge', () => {
  const sharedDish = { id: 'dish-rice', name: '鸡肉饭', ingredients: ['鸡肉', '米'], allergens: [],
    mealTypes: ['breakfast', 'lunch', 'dinner'], slot: 'main', supplyStatus: 'demo_available',
    isDemo: true, sourceReference: '重复长引用' };
  const fullContext = { candidates: ['breakfast', 'lunch', 'dinner'].map(mealType => ({
    candidateId: `${mealType}:dish-rice`, mealType, dish: sharedDish
  })), excluded: [{ mealType: 'lunch', dishId: 'dish-shrimp-noodles', dishName: '虾面',
    reason: '命中过敏限制', restrictionSourceId: 'guest-private-id', restrictionSource: 'health-intake' }],
    restrictions: [{ value: '虾', source: 'health-intake', sourceId: 'guest-private-id', status: 'pending' }],
    notices: ['过敏信息需现场核实'], profileVersion: 3, supplyBoundary: '仅为本地演示' };
  const projected = modelToolReply('domain.nutrition', { toolName: 'get_nutrition_context', status: 'completed',
    data: fullContext, sources: [{ type: 'dish', id: 'dish-rice', label: '鸡肉饭' }] });
  assert.deepEqual(projected.data.candidates.map(item => item.candidateId), [
    'breakfast:dish-rice', 'lunch:dish-rice', 'dinner:dish-rice'
  ]);
  assert.equal(projected.data.dishes.length, 1);
  assert.deepEqual(projected.data.dishes[0], { id: 'dish-rice', name: '鸡肉饭', ingredients: ['鸡肉', '米'],
    allergens: [], mealTypes: ['breakfast', 'lunch', 'dinner'], slot: 'main',
    supplyStatus: 'demo_available', isDemo: true });
  assert.equal(projected.data.excluded[0].reason, '命中过敏限制');
  assert.equal(projected.data.excluded[0].restrictionSource, 'health-intake');
  assert.equal(projected.data.restrictions[0].value, '虾');
  assert.equal(projected.data.restrictions[0].sourceId, undefined);
  assert.equal(projected.sources, undefined, 'duplicated source labels are omitted from model context');
  assert.equal(fullContext.candidates[0].dish.sourceReference, '重复长引用', 'persisted full tool data remains intact');

  const knowledge = modelToolReply('domain.nutrition', { toolName: 'get_nutrition_knowledge', status: 'completed',
    data: [{ knowledgeId: 'knowledge-nutrition-01', title: '饮食规则', summary: '按过敏限制排除菜品',
      sourceName: '原始来源名', sourceUrl: 'https://example.invalid', sourceReference: '实际知识正文' }],
    sources: [{ type: 'domain_knowledge', id: 'knowledge-nutrition-01', label: '饮食规则' }] });
  assert.deepEqual(knowledge.data, [{ knowledgeId: 'knowledge-nutrition-01', title: '饮食规则',
    summary: '按过敏限制排除菜品', sourceReference: '实际知识正文' }]);
});
