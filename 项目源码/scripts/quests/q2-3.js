import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { withTemporaryApi } from './helpers.js';

export async function run() {
  return withTemporaryApi(async ({ baseUrl, databasePath }) => {
    addSortingFixtures(databasePath);
    const response = await fetch(`${baseUrl}/news`);
    const news = await response.json();

    assert.equal(response.status, 200, 'public news list must return HTTP 200');
    assert.ok(Array.isArray(news) && news.length > 0, 'news list must contain at least one item');
    for (const item of news) {
      assert.equal(typeof item.title, 'string');
      assert.ok(item.title.trim(), 'news title must not be empty');
      assert.ok(Number.isFinite(Date.parse(item.publishedAt)), 'news item must include a valid publication date');
      assert.ok([0, 1].includes(Number(item.pinned)), 'news item must include a pinned flag');
    }

    for (let index = 1; index < news.length; index += 1) {
      const previous = news[index - 1];
      const current = news[index];
      assert.ok(Number(previous.pinned) >= Number(current.pinned), 'pinned news must precede ordinary news');
      if (Number(previous.pinned) === Number(current.pinned)) {
        assert.ok(Date.parse(previous.publishedAt) >= Date.parse(current.publishedAt), 'items in each pinned group must be newest first');
      }
    }

    const first = news[0];
    assert.equal(first.title, 'Q2.3 置顶排序样本');
    const newestOrdinaryIndex = news.findIndex(item => item.title === 'Q2.3 最新普通新闻样本');
    assert.ok(newestOrdinaryIndex > 1, 'a newer ordinary item must remain below both pinned items');
    return {
      output: [
        'HTTP 200',
        `newsCount=${news.length}`,
        `firstTitle=${first.title}`,
        `firstDate=${first.publishedAt}`,
        `firstPinned=${first.pinned}`
      ]
    };
  }, 'haiyu-quest-q2-3-');
}

function addSortingFixtures(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    const insert = database.prepare(`
      INSERT INTO news(category,title,summary,body,published_at,pinned)
      VALUES(?,?,?,?,?,?)
    `);
    insert.run('测试样本', 'Q2.3 置顶排序样本', '验证置顶优先。', '临时黑盒测试文章正文。', '2026-09-14T08:00:00Z', 1);
    insert.run('测试样本', 'Q2.3 最新普通新闻样本', '普通新闻日期较新。', '临时黑盒测试文章正文。', '2026-09-16T08:00:00Z', 0);
  } finally {
    database.close();
  }
}
