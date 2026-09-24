const quests = {
  'Q1.6': new URL('./quests/q1-6.js', import.meta.url),
};

const questId = process.argv[2];
if (!questId || !quests[questId]) {
  const available = Object.keys(quests).join(', ');
  console.error(`Usage: npm run quest -- <quest-id>${available ? ` (available: ${available})` : ''}`);
  process.exitCode = 1;
} else {
  try {
    const { run } = await import(quests[questId]);
    const result = await run();
    console.log(`PASS ${questId}`);
    for (const line of result.output) console.log(line);
  } catch (error) {
    console.error(`FAIL ${questId}: ${error?.stack || error}`);
    process.exitCode = 1;
  }
}
