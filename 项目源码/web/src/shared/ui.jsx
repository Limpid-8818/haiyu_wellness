import React from 'react';

// 全站共用的展示原子组件。渲染输出与原 main.jsx 内定义完全一致（DOM 契约冻结）。

export function PageTitle({ eyebrow, title, desc, action }) {
  return <div className="page-title"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1>{desc && <p>{desc}</p>}</div>{action}</div>;
}

export function Metric({ label, value, hint, tone }) {
  return <div className={`metric-card ${tone}`}><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>;
}

export function SectionHead({ title, link, onClick, action }) {
  return <div className="surface-head"><h2>{title}</h2>{action || (link && <button type="button" className="link-btn" onClick={onClick}>{link}　→</button>)}</div>;
}

export function Principle({ icon, title, text }) {
  return <div className="principle"><span>{icon}</span><div><strong>{title}</strong><p>{text}</p></div></div>;
}

export function Field({ label, value, onChange, type = 'text', placeholder = '', maxLength, minLength, inputMode, autoComplete, required = false }) {
  return <label>{label}<input type={type} value={value ?? ''} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} maxLength={maxLength} minLength={minLength} inputMode={inputMode} autoComplete={autoComplete} required={required}/></label>;
}

export function ReadonlyField({ label, value }) {
  return <div className="readonly-field"><label>{label} <span className="lock-mark" aria-hidden="true">🔒</span></label><input className="readonly-input" value={value || '—'} disabled readOnly aria-label={`${label}（只读）`}/></div>;
}

export function Info({ label, value }) {
  return <div className="info-item"><span>{label}</span><strong>{value || '—'}</strong></div>;
}

export function Empty({ text }) {
  return <div className="empty"><span>○</span><p>{text}</p></div>;
}

export function QueryState({ text, error = false, retryText = '', onRetry, retryLabel = '重试' }) {
  return <div className={`query-state ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}><span>{error ? '!' : '⌁'}</span><p>{text}</p>{retryText && <small>{retryText}</small>}{onRetry && <button type="button" className="outline-btn small-btn" onClick={onRetry}>{retryLabel}</button>}</div>;
}

export function ErrorState({ text, onRetry }) {
  return <div className="error-state" role="alert"><h2>暂时无法打开工作区</h2><p>{text}</p><button type="button" className="outline-btn" onClick={onRetry}>重新加载</button></div>;
}

export function Loading() {
  return <div className="loading" role="status"><span className="loader"/>正在载入你的空间…</div>;
}
