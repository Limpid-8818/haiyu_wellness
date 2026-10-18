import crypto from 'node:crypto';
import { hashPassword as makePasswordHash, verifyPassword as checkPassword } from './password.js';
import { systemBusinessClock } from './clock.js';

export function hashPassword(password) { return makePasswordHash(password); }
export function verifyPassword(password, stored) { return checkPassword(password, stored); }
export function id(prefix) { return `${prefix}_${crypto.randomUUID().slice(0, 8)}`; }
export function now() { return systemBusinessClock.utc(); }
export function json(value, fallback = []) {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; }
  catch { return fallback; }
}
