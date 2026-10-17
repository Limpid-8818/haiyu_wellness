import React, { useEffect, useState } from 'react';
import './environment.css';
import {businessTime} from './lib/release-presentation.js';
import {SourceDetails} from './SourceDetails.jsx';
import { businessToday as businessDateKey } from './lib/date.js';

function showValue(value, unit = '') {
  return !(typeof value === 'number' || (typeof value === 'string' && value.trim())) || !Number.isFinite(Number(value)) ? '暂无数据' : String(value) + unit;
}

function TideCurve({ hourly = [], events = [], modeled = false }) {
  const points = hourly.map((item, index) => ({ item, index, value: (typeof item.heightM === 'number' || (typeof item.heightM === 'string' && item.heightM.trim())) ? Number(item.heightM) : NaN }))
    .filter(point => Number.isFinite(point.value));
  if (points.length < 2) return <p className="environment-muted">暂无足够的逐时{modeled ? '预测海面高度' : '潮位'}数据，不能绘制曲线。</p>;
  const min = Math.min(...points.map(point => point.value));
  const max = Math.max(...points.map(point => point.value));
  const range = Math.max(max - min, 0.1);
  const xAt = index => 42 + (index / Math.max(hourly.length - 1, 1)) * 650;
  const yAt = value => 24 + ((max - value) / range) * 112;
  const plotted = points.map(point => xAt(point.index) + ',' + yAt(point.value)).join(' ');
  return <div className="environment-chart-wrap">
    <svg className="environment-tide-chart" viewBox="0 0 720 178" role="img" aria-label={modeled ? '含潮汐的模式海面高度预测曲线，全球平均海平面基准' : '潮位曲线；纵轴基准未知'}>
      <line x1="42" y1="24" x2="42" y2="140" className="environment-chart-axis"/>
      <line x1="42" y1="140" x2="692" y2="140" className="environment-chart-axis"/>
      <polyline points={plotted} className="environment-chart-line"/>
      {events.filter(event => ['high', 'low'].includes(event.type) && Number.isFinite(Number(event.heightM))).map((event, index) => {
        const matchIndex = hourly.findIndex(item => (item.localTime || item.time) === event.localTime);
        const x = xAt(Math.max(matchIndex, 0));
        const y = yAt(Number(event.heightM));
        return <g key={event.type + '-' + event.time + '-' + index}>
          <circle cx={x} cy={y} r="5" className={'environment-event-dot ' + event.type}/>
          <text x={x} y={Math.max(y - 9, 14)} textAnchor="middle" className="environment-chart-mark">{event.type === 'high' ? '高潮' : '低潮'}</text>
        </g>;
      })}
      <text x="42" y="162" className="environment-chart-tick">00:00</text>
      <text x="350" y="162" textAnchor="middle" className="environment-chart-tick">12:00</text>
      <text x="692" y="162" textAnchor="end" className="environment-chart-tick">23:00</text>
      <text x="4" y="18" className="environment-chart-tick">m</text>
    </svg>
    <div className="environment-chart-values">{modeled ? '含潮汐的模式海面高度预测' : '站点潮高'}：{min.toFixed(2)}–{max.toFixed(2)} m <span>· {modeled ? '全球平均海平面基准' : '垂直基准未知'}</span></div>
  </div>;
}

export default function EnvironmentPanel({ projectId = '', requestApi = null }) {
  const [date] = useState(businessDateKey);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [mockScenario, setMockScenario] = useState('');
  useEffect(() => {
    let current = true;
    const query = new URLSearchParams({ date });
    if (projectId) query.set('projectId', projectId);
    if (mockScenario) query.set('mockScenario', mockScenario);
    setLoading(true);
    // 优先使用注入的统一 request 封装（路径不带 /api 前缀，由封装添加）：
    // 401 过期登出、网络错误文案与全站一致（G21）。
    const pending = requestApi
      ? requestApi('/environment?' + query.toString())
      : fetch('/api/environment?' + query.toString(), {
        headers: (() => { const token = localStorage.getItem('community_token'); return token ? { Authorization: 'Bearer ' + token } : {}; })()
      }).then(async response => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || '环境信息暂时无法加载');
        return body;
      });
    pending.then(result => {
      if (!current) return;
      setData(result);
      setError('');
    }).catch(requestError => {
      if (!current) return;
      setData(null);
      setError(requestError.message || '环境信息暂时无法加载');
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [date, projectId, refresh, mockScenario, requestApi]);
  const statusLabel = data?.mock ? data.mock.label
    : data?.providerFixture?.mode === 'offline_fixture' ? data.providerFixture.label
    : data && data.status === 'demo' ? '合成演示资料 · 非实时'
    : data && data.status === 'available' ? '来源数据可用'
      : data && data.status === 'stale' ? '数据已过期'
        : '环境数据不可用';
  const weather = data && data.weather;
  const tide = data && data.tide;
  const marine = data && data.marine;
  const currentWeather = weather?.available ? weather.selectedPoint : null;
  const currentMarine = marine?.available ? marine.selectedPoint : null;
  const currentTide = tide?.available ? tide.selectedPoint : null;
  const modeledSeaLevelAvailable = tide?.mode === 'modeled-sea-level-including-tides'
    && tide.available && Number.isFinite(currentTide?.heightM);
  const gridCoordinateLabel = record => {
    const point = record?.providerCoordinates;
    return point && Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude))
      ? `网格中心 WGS84 ${Number(point.latitude).toFixed(4)}, ${Number(point.longitude).toFixed(4)}` : '供应商网格坐标不可用';
  };
  const uvLabels = { low: '低', moderate: '中等', high: '高', strong: '强', unknown: '机构分级未设置', missing: '指数缺失' };
  const availability = data && data.availability;
  const unavailable = !data || data.status === 'unavailable' || data.status === 'stale';
  const snapshotId = data && data.snapshotId || '';
  const snapshotLabel = snapshotId.length > 52 ? snapshotId.slice(0, 52) + '…' : snapshotId;
  return <section className={'surface environment-panel ' + (projectId ? 'environment-panel-detail' : 'environment-panel-home')} aria-labelledby={projectId ? 'environment-detail-title' : 'environment-home-title'}>
    <header className="environment-heading">
      <div><span className="eyebrow">ENVIRONMENT SNAPSHOT</span><h2 id={projectId ? 'environment-detail-title' : 'environment-home-title'}>{projectId ? '当日环境与时段核对' : '今日天气与潮汐'}</h2><p>{date} · {(data && data.location && data.location.timeZone) || '时区待确认'}</p></div>
      <div className="environment-heading-actions"><span className={'environment-status ' + ((data && data.status) || 'unavailable')}>{statusLabel}</span><button type="button" className="outline-btn small-btn" onClick={() => setRefresh(value => value + 1)} disabled={loading}>刷新</button></div>
    </header>
    {loading ? <div className="environment-state" role="status">正在读取环境快照…</div>
      : error ? <div className="environment-state environment-state-error" role="alert">{error}<p>没有数据时，下海项目保持待确认。</p></div>
        : <div className="environment-content">
          {data.mock && <div className="environment-mock-controls">
            <label>合成/mock场景 <select aria-label="合成/mock场景" value={mockScenario || data.mock.scenario}
              onChange={event => setMockScenario(event.target.value)} disabled={loading}>
              <option value="normal">normal · 字段齐全</option>
              <option value="risk">risk · 风险超限</option>
              <option value="missing">missing · 数据缺失</option>
              <option value="stale">stale · 快照过期</option>
            </select></label>
            <span>非实时 · 非机构批准 · 时间步 {data.mock.timeStep}</span>
          </div>}
          <div className="environment-location"><strong>{(data.location && data.location.name) || '机构地点未配置'}</strong><span>查询坐标 WGS84 {(data.location && data.location.latitude) ?? '未配置'} · {(data.location && data.location.longitude) ?? '未配置'}</span>
            {data.location?.coordinatesStatus === 'region-representative' && <span>地区代表点，非机构精确地址</span>}
            {tide?.mode === 'modeled-sea-level-including-tides'
              ? <span>站点潮位：当前模式不提供</span>
              : <span>潮汐站 {(data.location && data.location.tideStationId) || '未配置'}</span>}</div>
          {unavailable && <div className="environment-state environment-state-warning" role="status">
            <strong>{data && data.status === 'stale' ? '当前快照已过期' : '暂无可用环境数据'}</strong>
            <p>天气、潮汐或海况缺失/过期时，不会把下海项目判为安全。请等待有效来源数据或现场核验。</p>
            {data && data.missingConfig && data.missingConfig.length > 0 && <><small>所需环境资料尚未配置，请联系机构核对。</small><SourceDetails data={{missingConfig:data.missingConfig}}/></>}
          </div>}
          <p className="environment-muted" data-testid="environment-timepoint">{(currentWeather?.time || currentMarine?.time || currentTide?.time || '该小时数据点缺失').replace('T',' ')} · {data.timeZone || '时区不可核实'} · {currentWeather?.label || currentMarine?.label || currentTide?.label || '未用第一条记录补值'}</p>
          <div className="environment-metrics">
            <div><span>气温</span><strong>{showValue(currentWeather && currentWeather.temperatureC, ' °C')}</strong><small>{(weather && weather.sourceName) || '天气来源不可用'}</small></div>
            <div><span>风速</span><strong>{showValue(currentWeather && currentWeather.windSpeedKmh, ' km/h')}</strong><small>来源字段缺失时保持“暂无数据”</small></div>
            <div><span>紫外线</span><strong>{(currentWeather && currentWeather.uvIndex != null ? '指数 ' + String(currentWeather.uvIndex) : '指数缺失') + ' · ' + (data.sourceMode === 'demo' ? '合成示例分级' : '机构分级未设置')}</strong><small>指数与等级是不同字段；无指数会明确缺失，0仍是有效数值</small></div>
            <div><span>有效波高</span><strong>{showValue(currentMarine?.waveHeightM, ` ${marine?.units?.waveHeight || 'm'}`)}</strong><small>{(marine && marine.sourceName) || '海况来源不可用'}</small></div>
            <div><span>{tide?.mode === 'modeled-sea-level-including-tides' ? '含潮汐的模式海面高度（预测）' : '模型海面高度'}</span><strong>{showValue(modeledSeaLevelAvailable ? currentTide?.heightM : null, ` ${marine?.units?.modelSeaLevel || 'm'}`)}</strong><small>全球平均海平面基准；含潮汐与其他海面变化，不是官方站点实测潮位</small></div>
          </div>
          <SourceDetails summary="查看供应商来源与原始时间"><div className="environment-source-row">
            <span>天气：{weather && weather.sourceUrl ? <a href={weather.sourceUrl} target="_blank" rel="noreferrer">{weather.sourceName}</a> : (weather && weather.sourceName) || '来源不可用'} · {'采集时间 ' + (weather?.retrievedAt || '无法核实') + ' · 数据时刻 ' + (currentWeather?.instant || '缺失') + '（小时预报，非台站观测）'} · {gridCoordinateLabel(weather)} · 单位 {weather?.units?.temperature || '°C'}、{weather?.units?.windSpeed || 'km/h'}</span>
            <span>{tide?.mode === 'modeled-sea-level-including-tides' ? '含潮汐的模式海面高度：' : '站点潮汐：'}{tide && tide.sourceUrl ? <a href={tide.sourceUrl} target="_blank" rel="noreferrer">{tide.sourceName}</a> : (tide && tide.sourceName) || '来源不可用'} · 获取时间 {(tide && tide.retrievedAt) || '未知'} · 有效至 {(tide && tide.expiresAt) || '未知'} · {gridCoordinateLabel(tide)} · 数据时刻 {currentTide?.instant || '缺失'} · 基准 {tide?.verticalDatum === 'global mean sea level' ? '全球平均海平面' : '未说明'}</span>
            <span>海况：{marine && marine.sourceUrl ? <a href={marine.sourceUrl} target="_blank" rel="noreferrer">{marine.sourceName}</a> : (marine && marine.sourceName) || '来源不可用'} · 获取时间 {(marine && marine.retrievedAt) || '未知'} · {gridCoordinateLabel(marine)} · 数据时刻 {currentMarine?.instant || '缺失'} · 波高与含潮汐的预测海面高度分列</span>
          </div>
          </SourceDetails><div className="environment-events">
            <div><strong>{tide?.mode === 'modeled-sea-level-including-tides' ? '站点高潮 / 低潮时刻' : '高潮 / 低潮'}</strong>{tide?.mode === 'modeled-sea-level-including-tides'
              ? <span>当前模式不提供站点精确潮汐时刻</span>
              : tide && ['available', 'demo', 'stale'].includes(tide.status) && tide.events && tide.events.length
              ? tide.events.filter(event => ['high', 'low'].includes(event.type)).map((event, index) => <span key={event.time + '-' + index}>{event.type === 'high' ? '高潮' : '低潮'} {String(event.time).slice(11, 16)} · {showValue(event.heightM, ' m')}</span>)
              : <span>暂无潮汐时刻</span>}</div>
            <div><strong>资料有效期</strong><span>{businessTime(data.expiresAt)}</span><SourceDetails data={{snapshotId,sources:data.sources}}/></div>
          </div>
          <details className="environment-tide-details">
            <summary>{tide?.mode === 'modeled-sea-level-including-tides' ? '展开含潮汐的模式海面高度预测曲线' : '展开潮汐曲线（纵轴基准未知）'}</summary>
            {tide && ['available', 'demo'].includes(tide.status)
              ? <TideCurve hourly={tide.hourly || []} events={tide.events || []} modeled={tide.mode === 'modeled-sea-level-including-tides'}/>
              : <p className="environment-muted">暂无潮汐数据；下海项目保持待确认。</p>}
            <p className="environment-muted">{tide?.mode === 'modeled-sea-level-including-tides'
              ? '这是Open-Meteo对含潮汐及其他海面变化的模式预测，基准为全球平均海平面；不是本地官方台站实测潮位，不提供精确满潮或干潮时刻。'
              : '站点潮位与海面高度、海浪高度分列；来源没有说明垂直基准时保持未知。'}</p>
          </details>
          {projectId && <div className="environment-availability" role="status">
            <strong>项目时段演示核对</strong>
            {availability && availability.nextAvailable ? <span>下一个示例窗口 {availability.nextAvailable.date} {availability.nextAvailable.time}。需要现场确认，不创建预约。</span>
              : <span>{(availability && availability.reason) || '缺少环境资料，暂无可确认窗口。'}</span>}
            <small>{(availability && availability.reason) || '缺失、过期或合成演示数据不能用于真实安全放行。'}</small>
          </div>}
          <div className="environment-source-row" data-testid="environment-domain-states">{['weather','tide','marine'].map(domain => <span key={domain} data-domain={domain} data-source-id={data[domain]?.snapshotKey || ''}>{({weather:'天气',tide:'潮汐',marine:'海况'})[domain]}：{data[domain]?.available ? data[domain]?.status === 'demo' ? '合成示例资料' : '选中点可用' : data[domain]?.missingNote || '资料缺失'} · 有效至 {businessTime(data[domain]?.expiresAt)}</span>)}</div>
          <p className="environment-disclaimer">{(data.limitations || ['环境信息用于演示，不代表实时海况或专业安全判断。']).join(' ')}</p>
        </div>}
  </section>;
}
