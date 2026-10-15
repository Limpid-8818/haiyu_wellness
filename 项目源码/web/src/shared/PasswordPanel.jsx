import React, { useState } from 'react';
import { request } from '../lib/request.js';
import { Field } from './ui.jsx';

// 客人（我的资料）与工作人员（我的账号）共用的登录密码修改面板。
export function PasswordPanel({ notify }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ currentPassword: '', newPassword: '' });
  const [saving, setSaving] = useState(false);

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await request('/me/password', { method: 'POST', body: JSON.stringify(form) });
      notify('密码已修改，请妥善保管');
      setForm({ currentPassword: '', newPassword: '' });
      setOpen(false);
    } catch (error) {
      notify(error.message || '密码修改失败，请稍后再试');
    } finally {
      setSaving(false);
    }
  }

  return <section className="surface password-panel"><div><strong>登录密码</strong><p>定期修改密码，保护你的账号安全。</p></div><button type="button" className="outline-btn" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? '收起' : '修改密码'}</button>{open && <form className="password-form" onSubmit={save} aria-busy={saving}><Field label="当前密码" value={form.currentPassword} type="password" autoComplete="current-password" onChange={(value) => setForm({ ...form, currentPassword: value })} required/><Field label="新密码（至少 8 位）" value={form.newPassword} type="password" minLength={8} autoComplete="new-password" onChange={(value) => setForm({ ...form, newPassword: value })} required/><button type="submit" className="primary-btn" disabled={saving} aria-busy={saving}>{saving ? '修改中…' : '确认修改'}</button></form>}</section>;
}
