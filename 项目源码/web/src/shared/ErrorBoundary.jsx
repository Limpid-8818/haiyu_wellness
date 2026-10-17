import React from 'react';

// G19：渲染异常不再整站白屏，给出可操作的恢复入口并保留技术详情供排查。
export class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error('[web] render error:', error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <div className="error-boundary" role="alert">
      <h1>页面出现了一点问题</h1>
      <p>内容渲染遇到异常。你可以刷新页面重试；如果反复出现，请联系工作人员或开发者。</p>
      <details className="release-details"><summary>技术详情</summary><pre>{String(this.state.error?.stack || this.state.error)}</pre></details>
      <button type="button" className="primary-btn" onClick={() => window.location.reload()}>刷新页面</button>
    </div>;
  }
}
