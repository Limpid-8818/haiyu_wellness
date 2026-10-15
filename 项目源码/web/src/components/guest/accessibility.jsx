import React, { useEffect, useRef, useState } from 'react';
import { PageTitle } from '../../shared/ui.jsx';

export function contrastRatio(foreground, background) {
  const luminance = color => {
    const channels = color.match(/[0-9a-f]{2}/gi).map(channel => parseInt(channel, 16) / 255).map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return ((values[0] + 0.05) / (values[1] + 0.05)).toFixed(2);
}

export function GuestAccessibility({ go }) {
  const [sampleText, setSampleText] = useState('这段内容只用于控件交互示例。');
  const [state, setState] = useState({ kind: 'idle', text: '等待操作' });
  const [errorDetailsOpen, setErrorDetailsOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const notifySample = message => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  };
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const runSuccess = () => {
    setState({ kind: 'success', text: '保存成功：本页示例状态已更新。' });
    setErrorDetailsOpen(false);
    notifySample('示例操作已完成');
  };
  const runFailure = () => {
    setState({ kind: 'error', text: '操作失败：示例服务暂时无法响应。' });
    setErrorDetailsOpen(true);
    notifySample('示例操作失败，可查看详细原因');
  };
  const confirmClear = () => {
    setSampleText('');
    setConfirmOpen(false);
    setState({ kind: 'success', text: '已清除本页临时示例文字。' });
    notifySample('本页示例文字已清除');
  };

  return <div className="accessibility-page"><PageTitle eyebrow="ACCESSIBLE CONTROLS" title="适老化控件样本" desc="仅演示可读文字、操作状态和确认反馈，不提交或修改任何业务资料。" action={<button className="secondary-btn" type="button" onClick={() => go('my')}>← 返回我的</button>}/><section className="surface accessibility-card"><h2>对比度与文字</h2><div className="accessibility-swatches"><div className="accessibility-swatch body-swatch"><strong>正文文字示例</strong><span>海屿康养社区 · 清晰阅读</span><span>正文对比度 {contrastRatio('#153B47', '#F4FAF8')}:1</span></div><div className="accessibility-swatch button-swatch"><strong>海洋蓝按钮文字</strong><span>按钮文字对比度 {contrastRatio('#FFFFFF', '#0B6670')}:1</span></div></div><p>文字颜色 #153B47 / 浅海背景 #F4FAF8；海洋蓝 #0B6670 / 白字。</p></section><section className="surface accessibility-card"><h2>操作状态</h2><label className="accessibility-field" htmlFor="accessibility-sample-text">示例文字<input id="accessibility-sample-text" value={sampleText} onChange={event => setSampleText(event.target.value)} placeholder="输入本页临时示例文字"/></label><div className={`accessibility-state ${state.kind}`} role="status" aria-live="polite"><strong>状态：</strong>{state.text}</div><div className="accessibility-actions"><button className="accessibility-primary" type="button" onClick={runSuccess}>模拟成功</button><button className="accessibility-secondary" type="button" onClick={runFailure}>模拟失败</button><button className="accessibility-danger" type="button" onClick={() => setConfirmOpen(true)}>清除示例文字</button></div>{state.kind === 'error' && <><button className="accessibility-link" type="button" onClick={() => setErrorDetailsOpen(value => !value)}>{errorDetailsOpen ? '收起错误详情' : '查看错误详情'}</button>{errorDetailsOpen && <div className="accessibility-error-detail" role="alert"><strong>错误详情</strong><p>本地演示请求返回模拟网络错误。你可以稍后重试；此消息不会访问外部服务。</p></div>}</>}</section>{toast && <div className="age-toast" role="status" aria-live="polite">{toast}</div>}{confirmOpen && <div className="accessibility-modal-backdrop"><section className="accessibility-confirm" role="dialog" aria-modal="true" aria-labelledby="accessibility-confirm-title"><h2 id="accessibility-confirm-title">确认清除示例文字？</h2><p>这只会清空本页的临时输入示例，不影响个人资料、健康信息或医嘱。</p><div className="accessibility-actions"><button className="accessibility-secondary" type="button" onClick={() => setConfirmOpen(false)}>取消</button><button className="accessibility-danger" type="button" onClick={confirmClear}>确认清除</button></div></section></div>}</div>;
}
