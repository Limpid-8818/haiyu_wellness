import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// A local action owns its dialog. There is no pending confirmation Promise to leak
// when a page is replaced. showModal makes the rest of the document inert.
export function useConfirmation() {
  const [options, setOptions] = useState(null);
  const active = useRef(null);
  const confirm = useCallback(next => {
    if (active.current) return;
    active.current = next;
    setOptions(next);
  }, []);
  const close = useCallback(() => { active.current = null; setOptions(null); }, []);
  return { confirm, confirmation: options && <Confirmation options={options} onClose={close}/> };
}

function Confirmation({ options, onClose }) {
  const id = useId();
  const dialog = useRef(null);
  const cancel = useRef(null);
  const submitting = useRef(false);
  const controller = useRef(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    mounted.current = true;
    const trigger = document.activeElement;
    const element = dialog.current;
    element.showModal();
    cancel.current.focus();
    return () => {
      mounted.current = false;
      controller.current?.abort();
      element.close();
      if (trigger?.isConnected) trigger.focus();
      else {
        const main = document.querySelector('main');
        if (main) { main.setAttribute('tabindex', '-1'); main.focus(); }
      }
    };
  }, []);

  function cancelAction(event) {
    event?.preventDefault();
    if (!submitting.current) onClose();
  }
  function keyDown(event) {
    if (event.key === 'Escape') { cancelAction(event); return; }
    if (event.key !== 'Tab') return;
    const controls = [...dialog.current.querySelectorAll('button:not(:disabled)')];
    const index = controls.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && (index < 0 || index === controls.length - 1)) {
      event.preventDefault(); controls[0]?.focus();
    }
  }
  async function submit() {
    if (submitting.current) return;
    submitting.current = true;
    controller.current = new AbortController();
    setBusy(true); setError('');
    try {
      await options.action(controller.current.signal);
      if (mounted.current) onClose();
    } catch (actionError) {
      if (mounted.current) setError(actionError.message || '操作没有完成，请重试或取消');
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return createPortal(<dialog ref={dialog} className="confirmation-dialog" aria-modal="true"
    aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={cancelAction} onKeyDown={keyDown}>
    <h2 id={`${id}-title`}>{options.title}</h2>
    <p id={`${id}-description`}>{options.description}</p>
    {error && <p className="confirmation-error" role="alert">{error}</p>}
    {busy && <p role="status">正在处理，请稍候…</p>}
    <div className="confirmation-actions" aria-busy={busy}>
      <button ref={cancel} type="button" className="outline-btn" aria-disabled={busy} onClick={cancelAction}>取消</button>
      <button type="button" className="primary-btn" aria-disabled={busy} onClick={submit}>{busy ? '正在处理…' : options.confirmLabel}</button>
    </div>
  </dialog>, document.body);
}
