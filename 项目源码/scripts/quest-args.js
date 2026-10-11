export function parseQuestArgs(args) {
  const parsed = { questId: null, stage: null, dbPath: null, dbDriver: null, live: false, preflight: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--live') {
      parsed.live = true;
    } else if (arg === '--preflight') {
      parsed.preflight = true;
    } else if (arg.startsWith('--db=')) {
      const value = arg.slice('--db='.length);
      if (!value) throw new Error('--db requires a value');
      if (['sqlite', 'mysql'].includes(value.toLowerCase())) parsed.dbDriver = value.toLowerCase();
      else parsed.dbPath = value;
    } else if (arg === '--stage' || arg === '--db') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === '--db' && ['sqlite', 'mysql'].includes(value.toLowerCase())) parsed.dbDriver = value.toLowerCase();
      else if (arg === '--db') parsed.dbPath = value;
      else {
        const stage = Number(value);
        if (!Number.isSafeInteger(stage) || stage < 1) throw new Error('--stage must be a positive integer');
        parsed.stage = stage;
      }
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (parsed.questId) {
      throw new Error('provide only one quest ID');
    } else {
      parsed.questId = arg;
    }
  }
  if (parsed.questId && parsed.stage !== null) throw new Error('use either a quest ID or --stage, not both');
  if (parsed.live && parsed.preflight) throw new Error('use either --live or --preflight, not both');
  if (!parsed.help && !parsed.questId && parsed.stage === null) throw new Error('provide a quest ID or --stage');
  return parsed;
}

export function questsForStage(stage, questIds) {
  return questIds.filter(id => Number(id.match(/^Q(\d+)\./)?.[1]) === stage);
}
