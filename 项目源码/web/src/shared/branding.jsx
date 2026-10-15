import React from 'react';

export function Brand({ compact = false }) {
  return <div className={`brand ${compact ? 'compact' : ''}`}><span className="brand-mark">屿</span><div><strong>海屿康养社区</strong>{!compact && <small>本地网页演示</small>}</div></div>;
}
