function projectNutritionData(toolName, data) {
  if (toolName === 'get_nutrition_context') {
    const dishes = new Map();
    const candidates = (data?.candidates || []).map(item => {
      const dish = item.dish || {};
      if (dish.id && !dishes.has(dish.id)) {
        dishes.set(dish.id, { id: dish.id, name: dish.name, ingredients: dish.ingredients || [],
          allergens: dish.allergens || [], mealTypes: dish.mealTypes || [], slot: dish.slot,
          supplyStatus: dish.supplyStatus, isDemo: Boolean(dish.isDemo) });
      }
      return { candidateId: item.candidateId, mealType: item.mealType, dishId: dish.id };
    });
    return {
      candidates,
      dishes: [...dishes.values()],
      excluded: (data?.excluded || []).map(item => ({ mealType: item.mealType, dishId: item.dishId,
        dishName: item.dishName, reason: item.reason, restrictionSource: item.restrictionSource })),
      restrictions: (data?.restrictions || []).map(item => ({ value: item.value, source: item.source, status: item.status })),
      notices: data?.notices || [],
      supplyBoundary: data?.supplyBoundary || ''
    };
  }
  if (toolName === 'get_nutrition_knowledge') {
    return (Array.isArray(data) ? data : []).map(item => ({ knowledgeId: item.knowledgeId,
      title: item.title, summary: item.summary, sourceReference: item.sourceReference }));
  }
  return data;
}

export function modelToolReply(agentId, item) {
  if (agentId === 'domain.nutrition') {
    return { status: item.status, data: projectNutritionData(item.toolName, item.data) };
  }
  // Full source labels remain in the persisted trace. Tool data keeps the
  // safety rules and knowledge references used for candidate selection.
  return { status: item.status, data: item.data };
}
