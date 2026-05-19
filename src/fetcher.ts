import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import fs from 'fs';
import path from 'path';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import {
  type TrackerConfig,
  type TrackerStats,
  type FieldExtractor,
  type Credentials,
} from './types.js';
import { getProxyConfig } from './proxy.js';
import { selectUserAgent } from './userAgent.js';
import { closeBrowserSession, closeBrowserSessions, fetchWithBrowser } from './browserFetcher.js';

// ─── Transforms ──────────────────────────────────────────────────────────────

function parseBytes(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  const s = String(raw).trim().replace(',', '.');
  const m = s.match(/([\d\s.\u202f]+)\s*([KMGTPE](?:i?B|io|o)|B|o)/i);
  if (!m) return parseFloat(s) || 0;
  const n = parseFloat(m[1].replace(/[\s\u202f]/g, ''));
  const u = m[2].toUpperCase();
  const map: Record<string, number> = {
    B: 1,
    O: 1,
    KB: 1e3,   MB: 1e6,   GB: 1e9,   TB: 1e12,
    KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4,
    KO: 1e3,   MO: 1e6,   GO: 1e9,   TO: 1e12,
    KIO: 1024, MIO: 1024 ** 2, GIO: 1024 ** 3, TIO: 1024 ** 4,
  };
  return Math.round(n * (map[u] ?? 1));
}

function applyTransform(raw: unknown, tf?: string): string | number {
  if (raw === undefined || raw === null || raw === '') return '';
  switch (tf) {
    case 'bytes':   return parseBytes(raw);
    case 'number':  return parseFloat(String(raw).replace(',', '.')) || 0;
    case 'integer': return parseInt(String(raw), 10) || 0;
    default:        return String(raw);
  }
}

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce((acc: unknown, key) => {
    if (acc == null) return undefined;
    const arr = key.match(/^(.+)\[(\d+)\]$/);
    if (arr) return (acc as Record<string, unknown[]>)[arr[1]]?.[parseInt(arr[2])];
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function extractJson(
  json: unknown,
  fields: Record<string, FieldExtractor>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, ext] of Object.entries(fields)) {
    if (!ext.path) continue;
    out[name] = applyTransform(getPath(json, ext.path), ext.transform);
  }
  return out;
}

function extractHtml(
  html: string,
  fields: Record<string, FieldExtractor>,
): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [name, ext] of Object.entries(fields)) {
    if (!ext.regex) continue;
    const match = new RegExp(ext.regex, 's').exec(html);
    const val   = match?.groups?.['value'] ?? match?.[1];
    out[name]   = applyTransform(val, ext.transform);
  }
  return out;
}

function hasExtractedValues(fields: Record<string, string | number>): boolean {
  return Object.values(fields).some(value => (
    value !== '' && value !== undefined && value !== null
  ));
}

function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (
    message.includes('tls_get_more_records') ||
    message.includes('packet length too long') ||
    message.includes('EPROTO')
  ) {
    return `${message} - erreur TLS/proxy probable : verifier le type du proxy configure (HTTP vs HTTPS vs SOCKS)`;
  }
  return message;
}

function missingExtractedFields(
  configuredFields: Record<string, FieldExtractor>,
  extractedFields: Record<string, string | number>,
): string[] {
  return Object.keys(configuredFields).filter(key => {
    if (key === 'bufferBytes' && extractedFields.uploadedBytes !== '' && extractedFields.downloadedBytes !== '') {
      return false;
    }
    const value = extractedFields[key];
    return value === '' || value === undefined || value === null;
  });
}

function writeDebugDump(
  tracker: TrackerConfig,
  url: string,
  html: string,
  extractedFields: Record<string, string | number>,
  reason = 'extract',
): string | null {
  try {
    const dir = path.join(process.cwd(), 'config', 'debug');
    fs.mkdirSync(dir, { recursive: true });
    const safeId = tracker.id.replace(/[^a-z0-9_-]/gi, '_');
    const htmlPath = path.join(dir, `${safeId}-${reason}-last.html`);
    const metaPath = path.join(dir, `${safeId}-${reason}-last.json`);
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(metaPath, JSON.stringify({
      trackerId: tracker.id,
      trackerName: tracker.name,
      reason,
      url,
      dumpedAt: new Date().toISOString(),
      htmlLength: html.length,
      configuredFields: tracker.fetch.fields,
      extractedFields,
    }, null, 2));
    return htmlPath;
  } catch {
    return null;
  }
}

function writeLoginDebugDump(
  tracker: TrackerConfig,
  url: string,
  html: string,
  details: Record<string, unknown>,
): string | null {
  const path = writeDebugDump(tracker, url, html, {}, 'login');
  if (!path) return null;
  try {
    const metaPath = path.replace(/\.html$/, '.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      trackerId: tracker.id,
      trackerName: tracker.name,
      reason: 'login',
      url,
      dumpedAt: new Date().toISOString(),
      htmlLength: html.length,
      ...details,
    }, null, 2));
  } catch {
    // Keep login diagnostics best-effort only.
  }
  return path;
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function resolveUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  // Si c'est déjà une URL absolue, on la retourne telle quelle
  if (/^https?:\/\//.test(relativePath)) return relativePath;
  return new URL(relativePath, base).toString();
}

function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function extractHiddenInputs(html: string): Record<string, string> {
  const $ = cheerio.load(html);
  const fields: Record<string, string> = {};
  $('input[name]').each((_, input) => {
    const name = $(input).attr('name');
    if (!name) return;
    const type = ($(input).attr('type') ?? 'text').toLowerCase();
    const shouldCarry =
      type === 'hidden' ||
      (type === 'text' && name.startsWith('_'));
    if (!shouldCarry) return;
    fields[name] = $(input).attr('value') ?? '';
  });
  return fields;
}

function hasFailurePattern(text: string, patterns: string[]): string | null {
  for (const p of patterns) {
    if (text.toLowerCase().includes(p.toLowerCase())) return p;
  }
  return null;
}

function hasBrowserAuthFailure(
  tracker: TrackerConfig,
  url: string,
  html: string,
): string | null {
  const pathName = new URL(url).pathname;
  if (tracker.id === 'yggreborn' && pathName.startsWith('/account')) return null;
  if (pathName.includes('login') || pathName.includes('sign-in')) return 'login-url';
  return hasFailurePattern(html, tracker.login.failurePatterns);
}

function isAnubisChallenge(html: string): boolean {
  return html.includes('id="anubis_challenge"') ||
    html.includes('/.within.website/x/cmd/anubis/') ||
    html.includes("Vérification que vous n&#39;êtes pas un robot") ||
    html.includes("Verification que vous n&#39;etes pas un robot");
}

// ─── Session cache ────────────────────────────────────────────────────────────

interface Session {
  client: AxiosInstance;
  jar: CookieJar;
  loggedInAt: number;
}

// Sessions gardées en mémoire — une par tracker
const sessions = new Map<string, Session>();

// Relogin si la session a plus de 4h
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;

function requestUrl(config: InternalAxiosRequestConfig): string | null {
  if (!config.url) return null;
  try {
    return new URL(config.url, config.baseURL).toString();
  } catch {
    return null;
  }
}

async function storeResponseCookies(
  jar: CookieJar,
  response: AxiosResponse,
): Promise<void> {
  const url = response.config ? requestUrl(response.config) : null;
  const setCookie = response.headers['set-cookie'];
  if (!url || !setCookie) return;

  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  await Promise.all(cookies.map(cookie => jar.setCookie(cookie, url)));
}

function attachCookieJar(client: AxiosInstance, jar: CookieJar): void {
  client.interceptors.request.use(async config => {
    const url = requestUrl(config);
    if (!url) return config;

    const cookie = await jar.getCookieString(url);
    if (cookie) config.headers.set('Cookie', cookie);
    return config;
  });

  client.interceptors.response.use(
    async response => {
      await storeResponseCookies(jar, response);
      return response;
    },
    async error => {
      if (error.response) {
        await storeResponseCookies(jar, error.response);
      }
      throw error;
    },
  );
}

function createSession(): Session {
  const jar    = new CookieJar();
  const client = axios.create({
    withCredentials: true,
    timeout: 45_000,
    maxRedirects: 10,
    validateStatus: () => true, // on gère les erreurs nous-mêmes
    ...getProxyConfig(),
    headers: {
      'User-Agent': selectUserAgent(),
      'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,application/json,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  });
  attachCookieJar(client, jar);
  return { client, jar, loggedInAt: 0 };
}

function getSession(trackerId: string): Session {
  if (!sessions.has(trackerId)) {
    sessions.set(trackerId, createSession());
  }
  return sessions.get(trackerId)!;
}

export function invalidateSession(trackerId: string): void {
  // Recrée une session propre (nouveau jar = plus de vieux cookies)
  sessions.set(trackerId, createSession());
  closeBrowserSession(trackerId).catch(() => {});
}

export function invalidateAllSessions(): void {
  sessions.clear();
  closeBrowserSessions().catch(() => {});
  console.log('[Proxy] Sessions invalidées — reconnexion au prochain refresh');
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function doLogin(
  tracker: TrackerConfig,
  creds: { username: string; password: string },
  session: Session,
): Promise<void> {
  const { client, jar } = session;
  const cfg        = tracker.login;
  const base       = tracker.baseUrl;
  let refererUrl   = resolveUrl(base, cfg.url);

  const vars: Record<string, string> = {
    username: creds.username,
    password: creds.password,
  };
  let hiddenInputs: Record<string, string> = {};

  // ── 1. Pre-step (CSRF token, etc.) ─────────────────────────────────────────
  if (cfg.preStep) {
    const preUrl = resolveUrl(base, cfg.preStep.url);
    refererUrl = preUrl;
    const preRes = await client.get<string>(preUrl, { responseType: 'text' });
    if (cfg.preStep.includeHiddenInputs) {
      hiddenInputs = extractHiddenInputs(preRes.data);
    }

    for (const [key, ext] of Object.entries(cfg.preStep.extract)) {
      const match = new RegExp(ext.regex, 's').exec(preRes.data);
      vars[key]   = match?.groups?.['value'] ?? match?.[1] ?? '';
      if (!vars[key]) {
        throw new Error(`Pre-login : impossible d'extraire "${key}" depuis ${preUrl}`);
      }
    }
  }

  // ── 2. POST login ───────────────────────────────────────────────────────────
  const loginUrl = resolveUrl(base, cfg.url);
  const bodyObj: Record<string, string> = { ...hiddenInputs };
  for (const [k, v] of Object.entries(cfg.body)) {
    bodyObj[k] = interpolate(v, vars);
  }

  let loginRes;
  if ((cfg.contentType ?? 'form') === 'json') {
    loginRes = await client.post<string>(loginUrl, bodyObj, {
      responseType: 'text',
      maxRedirects: 0,
      headers: {
        'Content-Type': 'application/json',
        'Origin': new URL(base).origin,
        'Referer': refererUrl,
      },
    });
  } else {
    loginRes = await client.post<string>(
      loginUrl,
      new URLSearchParams(bodyObj).toString(),
      {
        responseType: 'text',
        maxRedirects: 0,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': new URL(base).origin,
          'Referer': refererUrl,
        },
      },
    );
  }

  // ── 3. Vérifier l'échec ─────────────────────────────────────────────────────
  await storeResponseCookies(jar, loginRes);

  let verificationHtml = loginRes.data;
  const location = loginRes.headers.location;
  if (loginRes.status >= 300 && loginRes.status < 400 && location) {
    const redirectedUrl = resolveUrl(loginUrl, Array.isArray(location) ? location[0] : location);
    const redirectedRes = await client.get<string>(redirectedUrl, {
      responseType: 'text',
      maxRedirects: 0,
    });
    await storeResponseCookies(jar, redirectedRes);
    verificationHtml = redirectedRes.data;
  }

  const failed = hasFailurePattern(verificationHtml, cfg.failurePatterns);
  if (failed) {
    const dumpPath = writeLoginDebugDump(tracker, loginUrl, verificationHtml, {
      failedPattern: failed,
      status: loginRes.status,
      location: loginRes.headers.location ?? null,
      hiddenInputNames: Object.keys(hiddenInputs),
      bodyFieldNames: Object.keys(bodyObj),
    });
    const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
    throw new Error(`Login échoué — "${failed}" trouvé dans la réponse${suffix}`);
    throw new Error(`Login échoué — "${failed}" trouvé dans la réponse`);
  }
  if (loginRes.status >= 400 && loginRes.status !== 302) {
    const dumpPath = writeLoginDebugDump(tracker, loginUrl, verificationHtml, {
      status: loginRes.status,
      location: loginRes.headers.location ?? null,
      hiddenInputNames: Object.keys(hiddenInputs),
      bodyFieldNames: Object.keys(bodyObj),
    });
    const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
    throw new Error(`Login échoué — HTTP ${loginRes.status}${suffix}`);
    throw new Error(`Login échoué — HTTP ${loginRes.status}`);
  }

  session.loggedInAt = Date.now();
  console.log(`  [${tracker.name}] Login OK`);
}

// ─── Fetch principal ──────────────────────────────────────────────────────────

export async function fetchTracker(
  tracker: TrackerConfig,
  creds: { username: string; password: string },
): Promise<TrackerStats> {
  let session = getSession(tracker.id);
  const vars: Record<string, string> = {
    username: creds.username,
    password: creds.password,
  };

  const buildStatsFromHtml = (url: string, html: string): TrackerStats => {
    if (isAnubisChallenge(html)) {
      const dumpPath = writeDebugDump(tracker, url, html, {}, 'anubis');
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`Challenge Anubis recu depuis ${url} - validation JavaScript navigateur requise${suffix}`);
    }

    let fields: Record<string, string | number>;
    if (tracker.fetch.responseType === 'json') {
      let json: unknown;
      try {
        json = JSON.parse(html);
      } catch {
        throw new Error('Reponse attendue en JSON, recu du HTML (mauvais endpoint ?)');
      }
      fields = extractJson(json, tracker.fetch.fields);
    } else {
      fields = extractHtml(html, tracker.fetch.fields);
    }

    if (!hasExtractedValues(fields)) {
      const dumpPath = writeDebugDump(tracker, url, html, fields);
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`Aucune donnee extraite depuis ${url} - selecteurs/regex a ajuster${suffix}`);
    }

    const missingFields = missingExtractedFields(tracker.fetch.fields, fields);
    if (missingFields.length > 0) {
      const dumpPath = writeDebugDump(tracker, url, html, fields, 'partial');
      console.log(`  [${tracker.name}] Champs manquants: ${missingFields.join(', ')}${dumpPath ? ` - dump: ${dumpPath}` : ''}`);
    }

    return {
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'ok',
      lastUpdated: new Date().toISOString(),
      lastLoginAt: session.loggedInAt ? new Date(session.loggedInAt).toISOString() : undefined,
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields,
    };
  };

  const attempt = async (isRetry = false): Promise<TrackerStats> => {
    if (tracker.fetch.mode === 'browser') {
      const browserResult = await fetchWithBrowser(tracker, creds);
      const failed = hasBrowserAuthFailure(tracker, browserResult.url, browserResult.html);
      if (failed) {
        if (!isRetry) {
          console.log(`  [${tracker.name}] Session navigateur expiree, re-login...`);
          // Reset complet du contexte navigateur (cookies en memoire) avant retry —
          // pour les sites ou la session persistante est devenue invalide
          await closeBrowserSession(tracker.id).catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 3000));
          return attempt(true);
        }
        const dumpPath = writeDebugDump(tracker, browserResult.url, browserResult.html, {}, 'browser-auth');
        const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
        throw new Error(`Session navigateur non authentifiee - verifier les credentials ou valider le challenge dans le profil navigateur${suffix}`);
      }
      return buildStatsFromHtml(browserResult.url, browserResult.html);
    }

    // Login si nécessaire
    const sessionExpired =
      !session.loggedInAt || Date.now() - session.loggedInAt > SESSION_TTL_MS;

    if (sessionExpired) {
      await doLogin(tracker, creds, session);
    }

    // Fetch des stats
    const url = resolveUrl(tracker.baseUrl, interpolate(tracker.fetch.url, vars));
    const res  = await session.client.get<string>(url, { responseType: 'text' });

    if (res.status >= 400) {
      throw new Error(`HTTP ${res.status} lors du fetch de ${url}`);
    }

    // Détection session expirée après le fetch
    const failed = hasFailurePattern(res.data, tracker.login.failurePatterns);
    if (failed) {
      if (isRetry) throw new Error(`Session expirée même après re-login — vérifier les credentials`);
      console.log(`  [${tracker.name}] Session expirée, re-login...`);
      invalidateSession(tracker.id);
      session = getSession(tracker.id);
      return attempt(true);
    }

    if (isAnubisChallenge(res.data)) {
      const dumpPath = writeDebugDump(tracker, url, res.data, {}, 'anubis');
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`Challenge Anubis recu depuis ${url} - validation JavaScript navigateur requise${suffix}`);
    }

    // Extraction des champs
    let fields: Record<string, string | number>;
    if (tracker.fetch.responseType === 'json') {
      let json: unknown;
      try {
        json = JSON.parse(res.data);
      } catch {
        throw new Error('Réponse attendue en JSON, reçu du HTML (mauvais endpoint ?)');
      }
      fields = extractJson(json, tracker.fetch.fields);
    } else {
      fields = extractHtml(res.data, tracker.fetch.fields);
    }

    if (!hasExtractedValues(fields)) {
      const dumpPath = writeDebugDump(tracker, url, res.data, fields);
      const suffix = dumpPath ? ` - dump: ${dumpPath}` : '';
      throw new Error(`Aucune donnee extraite depuis ${url} - selecteurs/regex a ajuster${suffix}`);
    }

    const missingFields = missingExtractedFields(tracker.fetch.fields, fields);
    if (missingFields.length > 0) {
      const dumpPath = writeDebugDump(tracker, url, res.data, fields, 'partial');
      console.log(`  [${tracker.name}] Champs manquants: ${missingFields.join(', ')}${dumpPath ? ` - dump: ${dumpPath}` : ''}`);
    }

    return {
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'ok',
      lastUpdated: new Date().toISOString(),
      lastLoginAt: session.loggedInAt ? new Date(session.loggedInAt).toISOString() : undefined,
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields,
    };
  };

  try {
    return await attempt();
  } catch (err: unknown) {
    invalidateSession(tracker.id); // reset pour le prochain cycle
    return {
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'error',
      error:       friendlyError(err),
      lastUpdated: new Date().toISOString(),
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields:      {},
    };
  }
}

export async function fetchAll(
  trackers: TrackerConfig[],
  credentials: Credentials,
): Promise<TrackerStats[]> {
  const enabled = trackers.filter(t => t.enabled !== false);
  return Promise.all(
    enabled.map(tracker => {
      const creds = credentials[tracker.id];
      if (!creds) {
        return Promise.resolve<TrackerStats>({
          id:          tracker.id,
          name:        tracker.name,
          trackerUrl:  tracker.baseUrl,
          status:      'error',
          error:       `Credentials manquants dans credentials.json pour "${tracker.id}"`,
          lastUpdated: new Date().toISOString(),
          byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
          fields:      {},
        });
      }
      return fetchTracker(tracker, creds);
    }),
  );
}
