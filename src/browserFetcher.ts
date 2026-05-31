import fs from 'fs';
import path from 'path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { resolveProxyForTracker } from './proxy.js';
import { selectUserAgent } from './userAgent.js';
import { getTrackerCookie } from './db.js';
import { type TrackerConfig } from './types.js';

interface InjectableCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

/**
 * Format Netscape (cookies.txt) : lignes TAB-separees a 7 champs
 * domain  includeSubdomains  path  secure  expiry  name  value
 * Les lignes "#HttpOnly_..." sont gerees, les autres "#" sont des commentaires.
 */
function parseNetscapeCookies(raw: string, host: string): InjectableCookie[] {
  const out: InjectableCookie[] = [];
  for (const line of raw.split(/\r?\n/)) {
    let l = line.trim();
    if (!l) continue;
    let httpOnly = false;
    if (l.startsWith('#HttpOnly_')) { httpOnly = true; l = l.slice('#HttpOnly_'.length); }
    else if (l.startsWith('#')) continue;
    const p = l.split('\t');
    if (p.length < 7) continue;
    const [domain, , cpath, secure, expiry, name] = p;
    const value = p.slice(6).join('\t');
    if (!name) continue;
    const cookie: InjectableCookie = {
      name,
      value,
      domain: domain || host,
      path: cpath || '/',
      secure: secure.toUpperCase() === 'TRUE',
      httpOnly,
    };
    const exp = Number(expiry);
    if (Number.isFinite(exp) && exp > 0) cookie.expires = exp;
    out.push(cookie);
  }
  return out;
}

/**
 * Convertit un cookie fourni par l'utilisateur en cookies injectables Playwright.
 * Accepte trois formats :
 *  - export JSON (extension type Cookie-Editor)
 *  - fichier Netscape cookies.txt (TAB-separe)
 *  - chaine d'en-tete "name=value; name2=value2" copiee depuis les devtools
 */
function parseCookies(raw: string, baseUrl: string): InjectableCookie[] {
  const host = new URL(baseUrl).hostname;
  const trimmed = raw.trim();

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((c: unknown): c is Record<string, unknown> =>
          Boolean(c) && typeof (c as Record<string, unknown>).name === 'string'
          && typeof (c as Record<string, unknown>).value !== 'undefined')
        .map((c) => {
          const domain = typeof c.domain === 'string' && c.domain ? c.domain : host;
          return {
            name: String(c.name),
            value: String(c.value),
            domain,
            path: typeof c.path === 'string' && c.path ? c.path : '/',
            secure: c.secure === true,
            httpOnly: c.httpOnly === true,
          };
        });
    } catch {
      // pas du JSON valide -> on essaie les autres formats
    }
  }

  // Format Netscape cookies.txt (contient des tabulations)
  if (trimmed.includes('\t')) {
    const netscape = parseNetscapeCookies(trimmed, host);
    if (netscape.length > 0) return netscape;
  }

  return trimmed
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      const name = (eq >= 0 ? part.slice(0, eq) : part).trim();
      const value = eq >= 0 ? part.slice(eq + 1).trim() : '';
      return { name, value, domain: host, path: '/' };
    })
    .filter(c => c.name.length > 0);
}

async function injectStoredCookies(tracker: TrackerConfig, context: BrowserContext): Promise<void> {
  const raw = getTrackerCookie(tracker.id);
  if (!raw) return;
  const cookies = parseCookies(raw, tracker.baseUrl);
  if (cookies.length === 0) return;
  await context.addCookies(cookies).catch((err: unknown) => {
    console.warn(`[Cookies] ${tracker.id} : injection echouee - ${err instanceof Error ? err.message : err}`);
  });
}

const PROFILE_DIR = path.join(process.cwd(), 'config', 'browser-profile');
const contexts = new Map<string, BrowserContext>();

function resolveUrl(baseUrl: string, relativePath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
  if (/^https?:\/\//.test(relativePath)) return relativePath;
  return new URL(relativePath, base).toString();
}

function interpolate(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

function hasFailurePattern(text: string, patterns: string[]): boolean {
  return patterns.some(pattern => text.toLowerCase().includes(pattern.toLowerCase()));
}

function isLoginPath(pathname: string): boolean {
  return pathname.includes('login') || pathname.includes('sign-in');
}

function isAnubisChallenge(html: string): boolean {
  return html.includes('id="anubis_challenge"') ||
    html.includes('/.within.website/x/cmd/anubis/') ||
    html.includes("Vérification que vous n&#39;êtes pas un robot") ||
    html.includes("Verification que vous n&#39;etes pas un robot");
}

function playwrightProxy(trackerId: string): { server: string; username?: string; password?: string } | undefined {
  const proxy = resolveProxyForTracker(trackerId);
  if (!proxy.enabled || !proxy.host || !proxy.port) return undefined;
  const server = `${proxy.type}://${proxy.host}:${proxy.port}`;
  return {
    server,
    username: proxy.username || undefined,
    password: proxy.password || undefined,
  };
}

async function getContext(tracker: TrackerConfig): Promise<BrowserContext> {
  const existing = contexts.get(tracker.id);
  if (existing) return existing;

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(
    path.join(PROFILE_DIR, tracker.id),
    {
      headless: true,
      userAgent: selectUserAgent(),
      proxy: playwrightProxy(tracker.id),
      viewport: { width: 1365, height: 900 },
      locale: 'fr-FR',
    },
  );
  await injectStoredCookies(tracker, context);
  contexts.set(tracker.id, context);
  return context;
}

async function waitForAnubis(page: Page): Promise<void> {
  let lastHtml = '';
  for (let i = 0; i < 45; i += 1) {
    const html = await safeContent(page);
    lastHtml = html;
    if (!isAnubisChallenge(html)) return;
    await page.waitForTimeout(1000);
  }
  if (isAnubisChallenge(lastHtml)) {
    throw new Error('Challenge Anubis encore present apres 45s dans Chromium');
  }
}

async function waitForLiveView(page: Page): Promise<void> {
  await page.waitForFunction(
    () => !document.querySelector('[data-phx-main].phx-loading'),
    null,
    { timeout: 30_000 },
  ).catch(() => {});
}

async function waitForTurnstile(page: Page): Promise<void> {
  if (await page.locator('.cf-turnstile').count() === 0) return;
  await page.waitForFunction(
    () => {
      const response = document.querySelector<HTMLInputElement>('input[name="cf-turnstile-response"]');
      return Boolean(response?.value);
    },
    null,
    { timeout: 20_000 },
  ).catch(() => {});
}

/**
 * Renvoie true si on a detecte un indicateur DOM de session authentifiee pour le tracker.
 * Permet de court-circuiter la detection de failurePatterns sur les SPAs qui affichent
 * une coquille "non connecte" avant hydratation (cas TR4KER).
 */
async function waitForTrackerContent(tracker: TrackerConfig, page: Page): Promise<boolean> {
  if (tracker.id !== 'tr4ker') return false;
  try {
    await page.waitForFunction(
      () => {
        const text = document.body?.innerText ?? '';
        return text.includes('RATIO') && text.includes('UPLOAD') && text.includes('DOWNLOAD');
      },
      null,
      { timeout: 60_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function safeContent(page: Page): Promise<string> {
  let lastError: unknown;
  for (let i = 0; i < 10; i += 1) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
      return await page.content();
    } catch (err) {
      lastError = err;
      await page.waitForTimeout(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function ensureLoggedIn(
  tracker: TrackerConfig,
  credentials: { username: string; password: string },
  page: Page,
): Promise<void> {
  const html = await safeContent(page);
  if (!hasFailurePattern(html, tracker.login.failurePatterns)) return;

  const loginUrl = resolveUrl(tracker.baseUrl, tracker.login.url);
  // 'commit' = on attend juste les headers HTTP, puis les waits explicites ci-dessous
  // s'occupent du DOM (plus robuste pour les sites lourds en JS / proxy lent)
  await page.goto(loginUrl, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
  await waitForAnubis(page);
  await waitForLiveView(page);
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await page.locator('input').first().waitFor({ timeout: 10_000 }).catch(() => {});

  for (const [name, template] of Object.entries(tracker.login.body)) {
    const value = interpolate(template, {
      username: credentials.username,
      password: credentials.password,
    });
    const candidates = [
      `[name="${name}"]`,
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[name="identifier"]' : '',
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[name="username"]' : '',
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[name="email"]' : '',
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[type="email"]' : '',
      ['username', 'email', 'login', 'identifier'].includes(name.toLowerCase()) ? 'input[type="text"]' : '',
      name.toLowerCase().includes('password') ? '#private-key-input' : '',
      name.toLowerCase().includes('password') ? 'input[type="password"]' : '',
    ].filter(Boolean);

    for (const selector of candidates) {
      const input = page.locator(selector);
      if (await input.count() === 0) continue;
      const target = input.first();
      const type = ((await target.getAttribute('type')) ?? 'text').toLowerCase();
      if (type === 'hidden') continue;
      if (type === 'checkbox') {
        if (value === 'true' || value === 'on' || value === '1') {
          // Une checkbox de login (ex: "remember me") est souvent stylisee/masquee par
          // du CSS : le clic natif echoue. On ne doit JAMAIS bloquer le login pour ca.
          await target.check({ timeout: 2500 }).catch(async () => {
            // Fallback : cocher directement via le DOM, meme si l'element est invisible.
            await target.evaluate(el => {
              if (el instanceof HTMLInputElement) {
                el.checked = true;
                el.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }).catch(() => { /* non bloquant */ });
          });
        }
        break;
      }
      await target.fill(value, { timeout: 5000 });
      break;
    }
  }

  await waitForLiveView(page);
  await waitForTurnstile(page);
  await page.waitForTimeout(250);

  const invalidFields = await page.locator('input:invalid').evaluateAll(inputs => inputs.map(input => {
    const el = input as HTMLInputElement;
    return el.name || el.id || el.type || 'input';
  })).catch(() => []);
  if (invalidFields.length > 0) {
    throw new Error(`Formulaire login invalide (${invalidFields.join(', ')}) - verifier le format des identifiants`);
  }

  const submit = page.locator('button[type="submit"], input[type="submit"]');
  if (await submit.count() > 0) {
    const button = submit.first();
    await button.waitFor({ state: 'visible', timeout: 10_000 });
    await page.waitForFunction(
      element => !(element instanceof HTMLButtonElement || element instanceof HTMLInputElement) || !element.disabled,
      await button.elementHandle(),
      { timeout: 10_000 },
    ).catch(() => {});
    await button.click({ timeout: 10_000 });
  } else {
    await page.keyboard.press('Enter');
  }
  await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {});
  const leftLogin = await page.waitForURL(url => !isLoginPath(url.pathname), { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!leftLogin && isLoginPath(new URL(page.url()).pathname)) {
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForURL(url => !isLoginPath(url.pathname), { timeout: 15_000 }).catch(() => {});
  }
  if (isLoginPath(new URL(page.url()).pathname)) {
    await page.locator('form').first().evaluate(form => {
      if (form instanceof HTMLFormElement) form.requestSubmit();
    }).catch(() => {});
    await page.waitForURL(url => !isLoginPath(url.pathname), { timeout: 15_000 }).catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
  await waitForAnubis(page);
  await waitForLiveView(page);
}

export async function fetchWithBrowser(
  tracker: TrackerConfig,
  credentials: { username: string; password: string },
): Promise<{ html: string; url: string; authConfirmed: boolean }> {
  const context = await getContext(tracker);
  const page = await context.newPage();
  const url = resolveUrl(tracker.baseUrl, interpolate(tracker.fetch.url, {
    username: credentials.username,
    password: credentials.password,
  }));

  try {
    await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await waitForAnubis(page);
    await waitForLiveView(page);
    await ensureLoggedIn(tracker, credentials, page);
    await page.goto(url, { waitUntil: 'commit', timeout: 45_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {});
    await waitForAnubis(page);
    await waitForLiveView(page);
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    if (tracker.id === 'nostradamus') {
      // Activity est rendu cote client via Phoenix LiveView - on attend que
      // l'ecran "Chargement de l'activite..." disparaisse avant de lire le HTML
      await page.waitForFunction(
        () => !document.getElementById('activity-loading-state'),
        null,
        { timeout: 30_000 },
      ).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
    }
    if (tracker.id === 'c411') {
      await page.getByText(/Envoy|Ratio|T[ée]l[ée]charg/i).first().waitFor({ timeout: 20_000 }).catch(() => {});
    }
    const authConfirmed = await waitForTrackerContent(tracker, page);
    return { html: await safeContent(page), url: page.url(), authConfirmed };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowserSessions(): Promise<void> {
  await Promise.all([...contexts.values()].map(context => context.close().catch(() => {})));
  contexts.clear();
}

export async function closeBrowserSession(trackerId: string): Promise<void> {
  const context = contexts.get(trackerId);
  if (!context) return;
  contexts.delete(trackerId);
  await context.close().catch(() => {});
}

/**
 * Reset complet du profil navigateur d'un tracker : ferme le contexte en memoire
 * PUIS supprime le profil persistant sur disque (cookies, localStorage, cache).
 * Le prochain fetch repartira d'une session navigateur vierge.
 */
export async function resetBrowserProfile(trackerId: string): Promise<void> {
  await closeBrowserSession(trackerId).catch(() => {});
  const dir = path.join(PROFILE_DIR, trackerId);
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
}
