export const PROJECT_SEEDS = [
  {
    id: 'project-sea-bath', slug: 'sea-bath', name: '海水浴', category: 'water_therapy', intensity: null,
    location: '东湾体验区（示例地点）',
    description: '亲海水疗体验项目。页面只展示项目说明，不代表服务已经开放，也不提供预约。',
    suitablePeople: '希望了解亲海体验且经现场工作人员核对适宜条件的客人（演示说明）。',
    contraindications: '皮肤破损按 R2 拒绝；其他健康限制由医护核对。本示例不提供临床适用判断。',
    openWindows: [{ days: ['每日'], start: '09:00', end: '11:00' }, { days: ['每日'], start: '14:00', end: '16:00' }],
    capacityPerWindow: 8, seaEntry: true, outdoor: true, activityTag: 'sea_bath'
  },
  {
    id: 'project-marine-hot-spring', slug: 'marine-hot-spring', name: '海洋温泉', category: 'water_therapy', intensity: null,
    location: '康养中心温泉区（示例地点）',
    description: '室内温泉体验项目。任何适宜性判断仍须由机构医护按实际情况确认。',
    suitablePeople: '仅用于展示项目资料；参与前需由现场工作人员核对设施说明与个人情况。',
    contraindications: '慢病命中 R1 时限制并转医护审核。本示例不设置水温、时长或诊疗阈值。',
    openWindows: [{ days: ['每日'], start: '10:00', end: '12:00' }, { days: ['每日'], start: '15:00', end: '17:00' }],
    capacityPerWindow: 6, seaEntry: false, outdoor: false, activityTag: 'hot_spring'
  },
  {
    id: 'project-spa', slug: 'spa', name: '水疗 SPA', category: 'water_therapy', intensity: null,
    location: '康养中心水疗室（示例地点）',
    description: '室内水疗服务项目介绍。具体服务内容、设备和流程须以机构现场说明为准。',
    suitablePeople: '适宜条件由服务人员按现场设施要求与医护意见核对。',
    contraindications: '本目录不设定治疗效果或临床阈值；如有健康限制，按正式档案及待核实约束处理。',
    openWindows: [{ days: ['周一', '周三', '周五'], start: '09:30', end: '11:30' }, { days: ['周二', '周四'], start: '14:00', end: '16:00' }],
    capacityPerWindow: 4, seaEntry: false, outdoor: false, activityTag: 'spa'
  },
  {
    id: 'project-sea-mud', slug: 'sea-mud', name: '海泥敷体', category: 'water_therapy', intensity: null,
    location: '康养中心护理室（示例地点）',
    description: '海泥敷体项目介绍。原料、接触范围和服务步骤以机构核验后的说明为准。',
    suitablePeople: '参与条件须由服务人员核对；皮肤情况不确定时先转医护确认。',
    contraindications: '皮肤破损按本演示规则 R2 拒绝；此项是项目需求演示规则，不构成临床结论。',
    openWindows: [{ days: ['每日'], start: '10:00', end: '12:00' }, { days: ['每日'], start: '14:00', end: '16:00' }],
    capacityPerWindow: 4, seaEntry: false, outdoor: false, activityTag: 'mud_application'
  },
  {
    id: 'project-swimming-training', slug: 'swimming-training', name: '游泳训练', category: 'exercise', intensity: 'medium',
    location: '东湾训练水域（示例地点）',
    description: '水中运动项目。强度等级是目录演示标签，不是个人运动处方。',
    suitablePeople: '水中活动能力经现场评估、并满足机构安全要求的客人（演示说明）。',
    contraindications: '行动能力需要协助时按 R4 拒绝并转医护核对；下海条件按 R5 核对。',
    openWindows: [{ days: ['周二', '周四', '周六'], start: '09:00', end: '10:00' }, { days: ['周二', '周四', '周六'], start: '15:00', end: '16:00' }],
    capacityPerWindow: 6, seaEntry: true, outdoor: true, activityTag: 'swimming_training'
  },
  {
    id: 'project-beach-walk', slug: 'beach-walk', name: '沙滩漫步', category: 'exercise', intensity: 'low',
    location: '东湾步行区（示例地点）',
    description: '沿沙滩步行的低强度运动项目。路线与地面情况以现场核验为准。',
    suitablePeople: '能够在现场确认的路线条件下步行，或已明确所需协助的客人（演示说明）。',
    contraindications: '行动能力与路线风险由工作人员核对；强紫外线按 R3 限制。',
    openWindows: [{ days: ['每日'], start: '07:30', end: '09:00' }, { days: ['每日'], start: '16:30', end: '18:00' }],
    capacityPerWindow: 12, seaEntry: false, outdoor: true, activityTag: 'walking'
  },
  {
    id: 'project-coastal-hike', slug: 'coastal-hike', name: '滨海徒步', category: 'exercise', intensity: 'high',
    location: '滨海步道（示例地点）',
    description: '滨海步道徒步项目。强度等级仅为目录标签，未连接路线海拔、距离或实时天气。',
    suitablePeople: '活动能力和路线要求经现场工作人员评估后适宜的客人（演示说明）。',
    contraindications: '不替代个体运动评估；强紫外线按 R3 限制，环境条件未核实时不作安全承诺。',
    openWindows: [{ days: ['周一', '周三', '周五', '周日'], start: '07:00', end: '09:00' }],
    capacityPerWindow: 10, seaEntry: false, outdoor: true, activityTag: 'hiking'
  },
  {
    id: 'project-morning-beach-exercise', slug: 'morning-beach-exercise', name: '晨间沙滩操', category: 'exercise', intensity: 'medium',
    location: '东湾活动广场（示例地点）',
    description: '团体晨间运动项目。动作和参与强度须由现场带领人员按参与者情况调整。',
    suitablePeople: '希望参加团体活动且现场确认参与条件合适的客人（演示说明）。',
    contraindications: '本目录不作个体运动建议；如健康档案提示限制，应先由医护核对。',
    openWindows: [{ days: ['每日'], start: '07:00', end: '07:45' }],
    capacityPerWindow: 16, seaEntry: false, outdoor: true, activityTag: 'group_exercise'
  },
  {
    id: 'project-tidal-foraging', slug: 'tidal-foraging', name: '赶海拾贝', category: 'seaside', intensity: null,
    location: '潮间带体验区（示例地点）',
    description: '潮间带观察体验。不得据此推定潮汐、安全路线或当地开放状态。',
    suitablePeople: '可在现场工作人员确认的路线和环境条件下参加者（演示说明）。',
    contraindications: '潮汐或海况输入缺失、未确认或不安全时按 R5 拒绝；强紫外线按 R3 限制。',
    openWindows: [{ days: ['周六', '周日'], start: '08:00', end: '10:00' }],
    capacityPerWindow: 8, seaEntry: true, outdoor: true, activityTag: 'tidal_foraging'
  },
  {
    id: 'project-sunrise-viewing', slug: 'sunrise-viewing', name: '观日出', category: 'seaside', intensity: null,
    location: '东湾观景平台（示例地点）',
    description: '海边观景活动介绍。页面所列地点和时间均为演示数据。',
    suitablePeople: '可前往现场核验后的观景点并满足通行条件的客人（演示说明）。',
    contraindications: '通行与天气信息须由工作人员现场确认；不包含海中活动。',
    openWindows: [{ days: ['每日'], start: '05:30', end: '07:00' }],
    capacityPerWindow: 12, seaEntry: false, outdoor: true, activityTag: 'viewing'
  },
  {
    id: 'project-seaside-photography', slug: 'seaside-photography-walk', name: '海边摄影漫步', category: 'seaside', intensity: null,
    location: '东湾观景步道（示例地点）',
    description: '海边摄影与慢行体验。路线、开放状态和现场协助方式均需机构核验。',
    suitablePeople: '希望进行轻量观景活动且现场确认通行条件合适的客人（演示说明）。',
    contraindications: '强紫外线按 R3 限制；不包含海中活动，也不构成天气安全判断。',
    openWindows: [{ days: ['每日'], start: '08:00', end: '10:00' }, { days: ['每日'], start: '16:00', end: '18:00' }],
    capacityPerWindow: 10, seaEntry: false, outdoor: true, activityTag: 'photography'
  }
];

export const KNOWLEDGE_SEEDS = [
  {
    id: 'knowledge-therapy-01', domain: 'therapy', title: '康复服务关注日常功能与参与',
    summary: 'WHO 将康复描述为优化功能、减少健康状况相关活动受限的干预集合。',
    body: '康复目标应联系个人的日常活动、环境和参与需要。服务路径需由具备相应资质的专业人员结合具体健康状况制定。本条不支持推断海水浴、温泉或海泥有治疗效果。',
    keywords: ['康复', '功能', '日常活动', '参与'], sourceName: 'WHO Rehabilitation fact sheet',
    sourceUrl: 'https://www.who.int/vietnam/news/fact-sheets/detail/rehabilitation'
  },
  {
    id: 'knowledge-therapy-02', domain: 'therapy', title: '康复服务应以人为中心并关注安全',
    summary: 'WHO 的康复服务资料强调服务质量、安全、及时可及和以人为中心。',
    body: '康复服务可涉及不同照护层级和环境，应根据个人需要安排服务和协作。演示项目目录不能替代康复专业人员对个人状况、环境和服务流程的评估。',
    keywords: ['康复服务', '安全', '以人为中心', '专业评估'], sourceName: 'WHO Rehabilitation service delivery',
    sourceUrl: 'https://www.who.int/teams/noncommunicable-diseases/sensory-functions-disability-and-rehabilitation/rehabilitation/service-delivery'
  },
  {
    id: 'knowledge-nutrition-01', domain: 'nutrition', title: '膳食建议考虑多样、均衡与个人差异',
    summary: 'WHO 提出健康膳食应兼顾充足、均衡、适度和多样，具体构成存在个体与文化差异。',
    body: '饮食建议应结合个人年龄、生活方式、健康状况、当地食物和饮食习惯。过敏与明确忌口需作为限制保留；涉及疾病治疗或个体营养处方时交由医护或营养专业人员确认。',
    keywords: ['健康膳食', '均衡', '多样', '忌口', '食物过敏'], sourceName: 'WHO Healthy diet fact sheet',
    sourceUrl: 'https://www.who.int/en/news-room/fact-sheets/detail/healthy-diet'
  },
  {
    id: 'knowledge-nutrition-02', domain: 'nutrition', title: '成人钠摄入参考值来自公共卫生指南',
    summary: 'WHO 建议成人每日钠摄入低于 2000 毫克，相当于食盐少于 5 克。',
    body: '这是 WHO 面向成人的公共卫生建议，不是针对个人疾病的膳食处方。医嘱、药物影响、个体营养需求或机构临床方案应优先由专业人员核定。',
    keywords: ['钠', '食盐', '成人', '营养指南'], sourceName: 'WHO Sodium reduction fact sheet',
    sourceUrl: 'https://www.who.int/news-room/fact-sheets/detail/sodium-reduction'
  },
  {
    id: 'knowledge-exercise-01', domain: 'exercise', title: '身体活动建议按人群和健康状况区分',
    summary: 'WHO 身体活动指南覆盖老年人，以及有慢性病或残障的人群。',
    body: '运动频率、强度和时长需要结合相应人群指南和个人健康情况。目录中的低、中、高强度是项目分类标签，不是个人运动处方或医学强度评估。',
    keywords: ['身体活动', '老年人', '慢病', '残障', '强度'], sourceName: 'WHO Guidelines on physical activity and sedentary behaviour',
    sourceUrl: 'https://www.who.int/publications/i/item/9789240014886'
  },
  {
    id: 'knowledge-exercise-02', domain: 'exercise', title: '老年人身体活动指南包含平衡与力量活动',
    summary: 'WHO 指南建议老年人将强调功能平衡与力量的多组分活动纳入每周身体活动。',
    body: 'WHO 对 65 岁及以上人群的建议包括每周至少 3 天开展强调功能平衡与力量的多组分身体活动。指南需结合具体情况理解；有慢性病、残障或其他限制时，应先按专业意见调整。',
    keywords: ['老年人', '平衡', '力量', '身体活动指南'], sourceName: 'WHO Regional Office for Europe: Physical activity',
    sourceUrl: 'https://www.who.int/europe/news-room/fact-sheets/item/physical-activity'
  },
  {
    id: 'knowledge-companionship-01', domain: 'companionship', title: '区分孤独感与社会隔离',
    summary: 'WHO 社会联结报告分别讨论主观孤独感与社会联系不足，并总结其健康与福祉影响。',
    body: '一个人可以独处而不感到孤独，也可能在人群中感到孤独。陪伴服务应尊重当事人的感受和选择；对持续困扰或心理健康问题，应转介适当专业支持。',
    keywords: ['孤独感', '社会隔离', '社会联结', '陪伴'], sourceName: 'WHO Commission on Social Connection report',
    sourceUrl: 'https://www.who.int/groups/commission-on-social-connection/report/'
  },
  {
    id: 'knowledge-companionship-02', domain: 'companionship', title: '为长者提供自愿且可选择的联络方式',
    summary: '美国国家老龄研究所提示，随年龄增长，行动、感官变化和亲友离世等因素可能影响社会联系。',
    body: '保持联系可通过面对面或电话与亲友交流、参加兴趣活动等方式进行。陪伴工作应先询问本人意愿，不把独处等同于孤独，也不把一般陪伴替代心理或医疗服务。',
    keywords: ['长者', '社会联系', '亲友', '兴趣活动', '本人意愿'], sourceName: 'National Institute on Aging: Tips for Staying Connected',
    sourceUrl: 'https://www.nia.nih.gov/health/loneliness-and-social-isolation/loneliness-and-social-isolation-tips-staying-connected'
  }
];

export const RULE_SEEDS = [
  {
    id: 'R1', title: '慢病与海洋温泉', scope: '海洋温泉',
    triggerCondition: '健康档案或待核实自述含高血压、心脏病等慢病，且项目为海洋温泉。',
    conditions: { profileField: 'chronic', projectTag: 'hot_spring', terms: ['高血压', '心脏病', '冠心病', '心衰'] },
    action: 'restrict', version: 'stage13-v1',
    sourceReference: '项目依据/01-project-design.md §MVP验收口径；RTM 20、95。需求演示规则，不是临床指南。', sourceUrl: '',
    demoNote: '命中后仅限制并要求医护审核；不推导水温、时长、疾病阈值或治疗建议。'
  },
  {
    id: 'R2', title: '皮肤破损与海水浴、海泥', scope: '海水浴、海泥敷体',
    triggerCondition: '健康档案或待核实自述描述皮肤破损、开放性伤口，且项目为海水浴或海泥敷体。',
    conditions: { profileField: 'skin', projectTags: ['sea_bath', 'mud_application'], terms: ['破损', '伤口', '开放'] },
    action: 'reject', version: 'stage13-v1',
    sourceReference: '项目依据/01-project-design.md §MVP验收口径；CDC Preventing Swimming-related Illnesses（开放性伤口水上活动提示）。海泥部分为项目需求演示策略。',
    sourceUrl: 'https://www.cdc.gov/healthy-swimming/prevention/index.html',
    demoNote: '规则动作按项目需求演示；CDC 提示不表示 CDC 对海泥治疗作出判断。'
  },
  {
    id: 'R3', title: '强紫外线与户外项目', scope: '户外项目',
    triggerCondition: '环境输入标记紫外线强，且项目为户外。',
    conditions: { environmentField: 'uvLevel', projectField: 'outdoor', value: 'strong' },
    action: 'restrict', version: 'stage13-v1',
    sourceReference: 'WHO Radiation: The ultraviolet (UV) index；项目需求 RTM 20、95。系统不设紫外线阈值。',
    sourceUrl: 'https://www.who.int/news-room/questions-and-answers/item/radiation-the-ultraviolet-%28uv%29-index',
    demoNote: '使用上游已判定的 strong 标签；本阶段无天气接入，不推断现场紫外线数值。'
  },
  {
    id: 'R4', title: '行动需要协助与游泳训练', scope: '游泳训练',
    triggerCondition: '正式健康资料或待核实自述显示行动需要协助，且项目为游泳训练。',
    conditions: { profileField: 'mobility', projectTag: 'swimming_training', status: 'assistance' },
    action: 'reject', version: 'stage13-v1',
    sourceReference: '项目依据/01-project-design.md §MVP验收口径；RTM 26。需求演示规则，不是个体运动处方。', sourceUrl: '',
    demoNote: '命中后拒绝本次示例候选并要求医护核对；不表示对所有行动受限者作普遍判断。'
  },
  {
    id: 'R5', title: '下海项目缺少或不安全的海况资料', scope: '下海项目',
    triggerCondition: '项目标记为下海类，且潮汐/海况输入未确认、缺失或不安全。',
    conditions: { environmentField: 'seaStatus', projectField: 'seaEntry', safeValue: 'safe' },
    action: 'reject', version: 'stage13-v1',
    sourceReference: '项目依据/04-test-plan.md R5-T01；RTM 50。NOAA Tide Predictions 仅作为潮位数据来源示例。',
    sourceUrl: 'https://tidesandcurrents.noaa.gov/tide_predictions',
    demoNote: '缺少输入时不放行；本阶段不接入实时天气、潮汐或海况，也不定义真实安全阈值。'
  }
];
