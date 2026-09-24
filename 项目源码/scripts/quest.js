const quests = {
  'Q1.6': new URL('./quests/q1-6.js', import.meta.url),
  'Q2.3': new URL('./quests/q2-3.js', import.meta.url),
  'Q2.5': new URL('./quests/q2-5.js', import.meta.url),
  'Q3.1': new URL('./quests/q3-1.js', import.meta.url),
  'Q3.2': new URL('./quests/q3-2.js', import.meta.url),
  'Q3.5': new URL('./quests/q3-5.js', import.meta.url),
  'Q3.8': new URL('./quests/q3-8.js', import.meta.url),
  'Q4.3': new URL('./quests/q4-3.js', import.meta.url),
  'Q4.5': new URL('./quests/q4-5.js', import.meta.url),
  'Q4.7': new URL('./quests/q4-7.js', import.meta.url),
  'Q5.1': new URL('./quests/q5-1.js', import.meta.url),
  'Q5.2': new URL('./quests/q5-2.js', import.meta.url),
  'Q5.3': new URL('./quests/q5-3.js', import.meta.url),
  'Q5.5': new URL('./quests/q5-5.js', import.meta.url),
  'Q5.8': new URL('./quests/q5-8.js', import.meta.url),
  'Q5.10': new URL('./quests/q5-10.js', import.meta.url),
  'Q5.12': new URL('./quests/q5-12.js', import.meta.url),
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
