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

export interface ProxyAxiosConfig {
  httpAgent?: unknown;
  httpsAgent?: unknown;
}

// ─── Lecture settings ─────────────────────────────────────────────────────────

export function loadProxySettings(): ProxySettings {
  return getJsonSetting('proxy', defaultProxy());
}

export function saveProxySettings(proxy: ProxySettings): void {
  setJsonSetting('proxy', proxy);
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

export function getProxyConfig(): ProxyAxiosConfig {
  return buildProxyConfig(loadProxySettings());
}

export function logProxyStatus(): void {
  const p = loadProxySettings();
  if (p.enabled && p.host && p.port) {
    console.log(`Proxy : ${p.type}://${p.host}:${p.port}`);
  } else if (p.directConnectAllowed) {
    console.log('Proxy desactive, connexion directe autorisee');
  } else {
    console.log('Proxy desactive, connexions trackers bloquees');
  }
}
