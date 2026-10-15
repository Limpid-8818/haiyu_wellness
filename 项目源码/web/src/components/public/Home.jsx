import React, { useEffect, useMemo, useState } from 'react';
import { request } from '../../lib/request.js';
import { fmtDate } from '../../lib/date.js';
import { businessText } from '../../../../shared/release-presentation.js';
import { QueryState } from '../../shared/ui.jsx';
import { Brand } from '../../shared/branding.jsx';
import { AssistantWidget } from '../assistant/AssistantWidget.jsx';

function PublicHeader({ onHome }) {
  return <header className="public-header"><Brand/><nav><button type="button" className="text-btn" onClick={onHome}>首页</button><a href="#news">社区动态</a><a href="#about">关于海屿</a></nav><div className="header-status"><span className="status-dot"/>服务正常</div></header>;
}

export function Home({ onEnter }) {
  const [news, setNews] = useState([]);
  const [selected, setSelected] = useState(null);
  const [newsLoading, setNewsLoading] = useState(true);
  const [newsError, setNewsError] = useState('');
  const weatherOptions = useMemo(() => [
    { label: '东南风 2 级', hint: '适合滨海漫步', icon: '☀' },
    { label: '多云 24°C', hint: '适合室外活动', icon: '☁' },
    { label: '海风 3 级', hint: '建议带一件薄外套', icon: '≈' },
    { label: '晴间多云', hint: '紫外线较强，注意防晒', icon: '◒' }
  ], []);
  const [weatherIndex, setWeatherIndex] = useState(() => Math.floor(Math.random() * weatherOptions.length));
  const weather = weatherOptions[weatherIndex];

  useEffect(() => {
    const controller = new AbortController();
    setNewsLoading(true);
    request('/news', { signal: controller.signal })
      .then((data) => setNews(Array.isArray(data) ? data : []))
      .catch((error) => {
        if (error?.name !== 'AbortError') {
          setNews([]);
          setNewsError(error.message || '社区动态暂时无法加载');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setNewsLoading(false);
      });
    return () => controller.abort();
  }, []);

  const featured = news[0];
  const newsState = newsLoading ? <QueryState text="正在加载社区动态…"/> : newsError ? <QueryState error text={newsError} retryText="社区动态暂时不可用"/> : !news.length ? <QueryState text="暂无社区动态"/> : null;

  return <div className="public-shell"><PublicHeader onHome={() => window.scrollTo({ top: 0, behavior: 'smooth' })}/><main>
    <section className="hero"><div className="hero-copy"><div className="eyebrow">面向每一个人的滨海康养服务</div><h1>把日子过得<br/><em>更从容一点</em></h1><p>海屿康养社区连接客人、医护与服务团队，让健康信息有边界地流动，让每一次照护都更贴近真实需要。</p><div className="hero-actions"><button type="button" className="primary-btn" onClick={() => onEnter('guest')}>我是客人 <span>→</span></button><button type="button" className="secondary-btn" onClick={() => onEnter('staff')}>我是工作人员 <span>→</span></button><button type="button" className="secondary-btn" onClick={() => onEnter('dean')}>院长管理入口 <span>→</span></button></div><div className="hero-note"><span>✦</span> 个人信息仅在授权工作区内展示</div></div><div className="hero-art"><div className="sun"/><div className="wave wave-a"/><div className="wave wave-b"/><button type="button" className="hero-card" onClick={() => setWeatherIndex(index => (index + 1) % weatherOptions.length)} aria-label="切换演示天气"><span className="mini-label">今日海风 · 演示数据　↻ 点击切换</span><strong>{weather.icon} {weather.label}</strong><span className="mini-muted">{weather.hint}</span></button></div></section>
    <section className="trust-strip"><div><strong>清晰的角色边界</strong><span>客人和工作人员各自拥有独立空间</span></div><div><strong>可追溯的健康记录</strong><span>每条医嘱都记录来源与时间</span></div><div><strong>温和而专业的服务</strong><span>让照护回到人与人的连接</span></div></section>
    <section className="news-section" id="news"><div className="section-heading"><div><div className="eyebrow">COMMUNITY JOURNAL</div><h2>社区动态</h2></div><button type="button" className="link-btn" onClick={() => document.getElementById('news-grid')?.scrollIntoView({ behavior: 'smooth' })}>查看全部 <span>↗</span></button></div><div className="featured-news">{featured ? <><div className="featured-image"><span>{featured.category}</span><div className="feature-symbol">{featured.category === '健康管理' ? '◒' : featured.category === '滨海活动' ? '≈' : '✣'}</div></div><div className="featured-copy"><div className="news-meta"><span className="tag">置顶</span><span>{featured.category}</span><span>{fmtDate(featured.publishedAt)}</span></div><h3>{featured.title}</h3><p>{featured.summary}</p><button type="button" className="read-btn" onClick={() => setSelected(featured)}>阅读全文 <span>→</span></button></div></> : <div className="news-empty">{newsState}</div>}</div><div className="news-grid" id="news-grid">{news.slice(1).map(item => <article className="news-card" key={item.id} role="button" tabIndex="0" onClick={() => setSelected(item)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(item); } }}><div className="card-top"><span className="category-dot"/>{item.category}<time>{fmtDate(item.publishedAt)}</time></div><h3>{item.title}</h3><p>{businessText(item.summary)}</p><span className="card-arrow">↗</span></article>)}</div></section>
    <section className="entry-section"><div className="entry-copy"><div className="eyebrow">YOUR SPACE</div><h2>从这里，进入<br/><em>属于你的空间</em></h2><p>不同的身份，不同的工作台。选择身份后，我们会把你需要的内容放在最顺手的位置。</p></div><div className="entry-cards"><button type="button" onClick={() => onEnter('guest')}><span className="entry-icon blue">⌂</span><span><strong>我是客人</strong><small>查看我的资料、健康与医嘱</small></span><b>→</b></button><button type="button" onClick={() => onEnter('staff')}><span className="entry-icon orange">✚</span><span><strong>我是工作人员</strong><small>管理负责客人并提供专业建议</small></span><b>→</b></button><button type="button" onClick={() => onEnter('dean')}><span className="entry-icon orange">♜</span><span><strong>院长管理入口</strong><small>查看团队记录并留下管理意见</small></span><b>→</b></button></div></section>
    <section className="about-section" id="about"><div className="about-number">01</div><div><div className="eyebrow">ABOUT HAIYU</div><h2>让信息更有边界，<br/>让照护更有温度。</h2></div><p>海屿不是把所有信息堆在一起的管理后台，而是一座有公共客厅、个人房间和专业工作台的社区。首页属于所有人，档案只属于被授权的人。</p></section>
  </main><footer><Brand compact/><span>© 2026 海屿康养社区 · 面向康养服务场景的数字化平台</span><span>隐私政策　服务说明</span></footer>{selected && <NewsModal item={selected} onClose={() => setSelected(null)}/>}<AssistantWidget role="public"/></div>;
}

function NewsModal({ item, onClose }) {
  return <div className="modal-backdrop" onClick={onClose}><div className="news-modal" onClick={(event) => event.stopPropagation()}><button type="button" className="close-btn" onClick={onClose} aria-label="关闭新闻详情">×</button><div className="news-meta"><span className="tag">{item.category}</span><span>{fmtDate(item.publishedAt)}</span></div><h2>{item.title}</h2><p className="modal-summary">{item.summary}</p><div className="modal-body">{item.body}</div></div></div>;
}
