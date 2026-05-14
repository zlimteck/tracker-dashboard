import crypto from 'crypto';
import { getJsonSetting, setJsonSetting } from './db.js';

export interface AuthSettings {
  username: string;
  passwordHash: string;
  salt: string;
  iterations: number;
}

const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_SECRET_KEY = 'authSecret';
const AUTH_KEY = 'auth';

function hashPassword(password: string, salt: string, iterations: number): string {
  return crypto.pbkdf2Sync(password, salt, iterations, 64, 'sha512').toString('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export function getAuthSettings(): AuthSettings | null {
  const auth = getJsonSetting<AuthSettings | null>(AUTH_KEY, null);
  if (!auth?.username || !auth.passwordHash || !auth.salt) return null;
  return auth;
}

export function isAuthConfigured(): boolean {
  return getAuthSettings() !== null;
}

export function saveAuthSettings(username: string, password: string): void {
  const salt = crypto.randomBytes(16).toString('hex');
  const iterations = 210_000;
  setJsonSetting(AUTH_KEY, {
    username,
    passwordHash: hashPassword(password, salt, iterations),
    salt,
    iterations,
  });
}

export function verifyLogin(username: string, password: string): boolean {
  const auth = getAuthSettings();
  if (!auth || username !== auth.username) return false;
  const hash = hashPassword(password, auth.salt, auth.iterations);
  return timingSafeEqual(hash, auth.passwordHash);
}

function getSessionSecret(): string {
  const existing = getJsonSetting<{ secret: string } | null>(SESSION_SECRET_KEY, null);
  if (existing?.secret) return existing.secret;
  const secret = crypto.randomBytes(32).toString('hex');
  setJsonSetting(SESSION_SECRET_KEY, { secret });
  return secret;
}

export function createSessionCookie(username: string): string {
  const payload = {
    username,
    expiresAt: Date.now() + SESSION_TTL_MS,
    nonce: crypto.randomBytes(12).toString('hex'),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSessionSecret())
    .update(body)
    .digest('base64url');
  return `${body}.${sig}`;
}

export function verifySessionCookie(cookie: string | undefined): boolean {
  if (!cookie) return false;
  const [body, sig] = cookie.split('.');
  if (!body || !sig) return false;

  const expected = crypto
    .createHmac('sha256', getSessionSecret())
    .update(body)
    .digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) as {
      expiresAt?: number;
    };
    return Number(payload.expiresAt) > Date.now();
  } catch {
    return false;
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  const parts = header.split(';').map(part => part.trim());
  const prefix = `${name}=`;
  return parts.find(part => part.startsWith(prefix))?.slice(prefix.length);
}
