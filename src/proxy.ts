import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { getJsonSetting, setJsonSetting } from './db.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProxySettings {
  enabled: boolean;
  type: string;
  host: string;
  port: string;
  username: string;
  password: string;
  directConnectAllowed: boolean;
}

/**
 * Surcharge de proxy par tracker — pour tel ou tel site on passe par un autre
 * proxy que le proxy global. Pratique pour des sites qui blacklistent l'IP
 * du proxy principal.
 */
export interface ProxyOverride {
  id: string;
  label: string;
  enabled: boolean;
  /** Si true, ce tracker sort sans proxy meme si un proxy global est actif. */
  direct: boolean;
  /** Liste des ids de trackers qui passent par ce proxy */
  trackers: string[];
  type: string;
  host: string;
  port: string;
  username: string;
  password: string;
}

export interface ProxyAxiosConfig {
  httpAgent?: unknown;
  httpsAgent?: unknown;
}

// ─── Lecture / ecriture settings ──────────────────────────────────────────────

export function loadProxySettings(): ProxySettings {
  return getJsonSetting('proxy', defaultProxy());
}

export function saveProxySettings(proxy: ProxySettings): void {
  setJsonSetting('proxy', proxy);
}

export function loadProxyOverrides(): ProxyOverride[] {
  const raw = getJsonSetting('proxy_overrides', [] as ProxyOverride[]);
  return Array.isArray(raw) ? raw : [];
}

export function saveProxyOverrides(overrides: ProxyOverride[]): void {
  setJsonSetting('proxy_overrides', overrides);
}

function defaultProxy(): ProxySettings {
  return {
    enabled: false,
    type: 'socks5',
    host: '',
    port: '',
    username: '',
    password: '',
    directConnectAllowed: false,
  };
}

// ─── Resolution proxy pour un tracker donne ───────────────────────────────────

/**
 * Renvoie le proxy effectif pour un tracker :
 *  - s'il existe un override active qui liste ce trackerId, on l'utilise
 *  - sinon, on retombe sur le proxy global
 *
 * Le retour est un ProxySettings (meme forme) pour que les callers s'en
 * fichent : ils ne savent pas si c'est l'override ou le global.
 */
export function resolveProxyForTracker(trackerId?: string): ProxySettings {
  if (trackerId) {
    const override = loadProxyOverrides().find(
      o => o.enabled && Array.isArray(o.trackers) && o.trackers.includes(trackerId),
    );
    if (override?.direct) {
      return {
        enabled: false,
        type: 'direct',
        host: '',
        port: '',
        username: '',
        password: '',
        directConnectAllowed: true,
      };
    }
    if (override && override.host && override.port) {
      return {
        enabled: true,
        type:     override.type,
        host:     override.host,
        port:     override.port,
        username: override.username,
        password: override.password,
        // Un override ne reactive pas la connexion directe — c'est un detail du proxy global
        directConnectAllowed: false,
      };
    }
  }
  return loadProxySettings();
}

// ─── Config axios ─────────────────────────────────────────────────────────────

export function buildProxyConfig(proxy: ProxySettings): ProxyAxiosConfig {
  if (!proxy.enabled || !proxy.host || !proxy.port) return {};

  const auth     = proxy.username && proxy.password
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`
    : '';
  const proxyUrl = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;

  try {
    const agent = proxy.type.startsWith('socks')
      ? new SocksProxyAgent(proxyUrl)
      : new HttpsProxyAgent(proxyUrl);
    return { httpAgent: agent, httpsAgent: agent };
  } catch (err: unknown) {
    console.error('[Proxy] Erreur de configuration :', err instanceof Error ? err.message : err);
    return {};
  }
}

export function getProxyConfig(trackerId?: string): ProxyAxiosConfig {
  return buildProxyConfig(resolveProxyForTracker(trackerId));
}

export function logProxyStatus(): void {
  const p = loadProxySettings();
  if (p.enabled && p.host && p.port) {
    console.log(`Proxy global : ${p.type}://${p.host}:${p.port}`);
  } else if (p.directConnectAllowed) {
    console.log('Proxy global desactive, connexion directe autorisee');
  } else {
    console.log('Proxy global desactive, connexions trackers bloquees (hors overrides)');
  }
  const overrides = loadProxyOverrides().filter(o => o.enabled);
  if (overrides.length > 0) {
    for (const o of overrides) {
      const target = o.trackers.join(', ') || '(aucun tracker)';
      const route = o.direct ? 'connexion directe' : `${o.type}://${o.host}:${o.port}`;
      console.log(`  Override [${o.label || o.id}] -> ${route} pour ${target}`);
    }
  }
}
