import fs from 'fs';
import path from 'path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { resolveProxyForTracker } from './proxy.js';
import { selectUserAgent } from './userAgent.js';
import { getTrackerCookie } from './db.js';
import { type TrackerConfig } from './types.js';

// Cookie minimal : on garde juste name+value (+ flags), et on injecte via `url`
// (Playwright derive domaine/chemin) -> bien plus robuste que domain/path manuels.
interface ParsedCookie {
  name: string;
  value: string;
  secure?: boolean;
  httpOnly?: boolean;
  expires?: number;
}

const COOKIE_NAME_RE = /^[^\s=;,]+$/; // un nom de cookie valide ne contient ni espace, ni = ; ,

/**
 * Format Netscape (cookies.txt) : 7 champs
 * domain  includeSubdomains  path  secure  expiry  name  value
 * Separes par TAB normalement ; on tolere aussi les espaces multiples au cas ou
 * le copier-coller aurait converti les tabulations.
 */
function parseNetscapeCookies(raw: string): ParsedCookie[] {
  const out: ParsedCookie[] = [];
  for (const line of raw.split(/\r?\n/)) {
    let l = line.trim();
    if (!l) continue;
    let httpOnly = false;
    if (l.startsWith('#HttpOnly_')) { httpOnly = true; l = l.slice('#HttpOnly_'.length); }
    else if (l.startsWith('#')) continue;
    let p = l.split('\t');
    if (p.length < 7) p = l.split(/\s+/); // tolerance : tabs convertis en espaces
    if (p.length < 7) continue;
    const name = p[5];
    const value = p.slice(6).join(' ');
    if (!name || !COOKIE_NAME_RE.test(name)) continue;
    const cookie: ParsedCookie = {
      name,
      value,
      secure: String(p[3]).toUpperCase() === 'TRUE',
      httpOnly,
    };
    const exp = Number(p[4]);
    if (Number.isFinite(exp) && exp > 0) cookie.expires = exp;
    out.push(cookie);
  }
  return out;
}

/**
 * Convertit le cookie fourni par l'utilisateur. Trois formats acceptes :
 *  - export JSON (Cookie-Editor : name/value/secure/httpOnly/expirationDate)
 *  - fichier Netscape cookies.txt
 *  - chaine d'en-tete "name=value; name2=value2"
 */
function parseCookies(raw: string): ParsedCookie[] {
  const trimmed = raw.trim();

  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .filter((c: unknown): c is Record<string, unknown> =>
          Boolean(c) && typeof (c as Record<string, unknown>).name === 'string')
        .map((c) => {
          const cookie: ParsedCookie = {
            name: String(c.name),
            value: String(c.value ?? ''),
            secure: c.secure === true,
            httpOnly: c.httpOnly === true,
          };
          const exp = Number(c.expirationDate ?? c.expires);
          if (Number.isFinite(exp) && exp > 0) cookie.expires = Math.floor(exp);
          return cookie;
        })
        .filter(c => COOKIE_NAME_RE.test(c.name));
    } catch {
      // pas du JSON valide -> autres formats
    }
  }

  if (trimmed.includes('\t') || /\n/.test(trimmed)) {
    const netscape = parseNetscapeCookies(trimmed);
    if (netscape.length > 0) return netscape;
  }

  // En-tete "name=value; name2=value2"
  return trimmed
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      const name = (eq >= 0 ? part.slice(0, eq) : part).trim();
      const value = eq >= 0 ? part.slice(eq + 1).trim() : '';
      return { name, value };
    })
    .filter(c => COOKIE_NAME_RE.test(c.name));
}

async function injectStoredCookies(tracker: TrackerConfig, context: BrowserContext): Promise<void> {
  const raw = getTrackerCookie(tracker.id);
  if (!raw) return;
  const parsed = parseCookies(raw);
  if (parsed.length === 0) {
    console.warn(`[Cookies] ${tracker.id} : aucun cookie reconnu dans la valeur fournie (format invalide ?)`);
    return;
  }
  // Injection via `url` : Playwright en deduit domaine/chemin -> robuste.
  const url = tracker.baseUrl;
  const cookies = parsed.map(c => ({
    name: c.name,
    value: c.value,
    url,
    ...(c.secure !== undefined ? { secure: c.secure } : {}),
    ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
    ...(c.expires !== undefined ? { expires: c.expires } : {}),
  }));
  try {
    await context.addCookies(cookies);
    console.log(`[Cookies] ${tracker.id} : ${cookies.length} cookie(s) injecte(s) (${parsed.map(c => c.name).join(', ')})`);
  } catch (err: unknown) {
    console.warn(`[Cookies] ${tracker.id} : injection echouee - ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Applique le cookie stocke a un contexte DEJA ouvert (sans le fermer), pour une
 * prise en compte immediate apres enregistrement, sans casser un fetch en cours.
 * Si aucun contexte n'existe, le cookie sera injecte au prochain getContext.
 */
export async function applyStoredCookies(tracker: TrackerConfig): Promise<void> {
  const context = contexts.get(tracker.id);
  if (context) await injectStoredCookies(tracker, context);
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
