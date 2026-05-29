// ─── Config (trackers.json) ───────────────────────────────────────────────────

/** Étape optionnelle avant le login — sert à récupérer un token CSRF */
export interface PreLoginStep {
  url: string;
  /** Extractions via regex avec groupe nommé (?<value>...) */
  extract: Record<string, { regex: string }>;
  includeHiddenInputs?: boolean;
}

export interface LoginConfig {
  url: string;
  method?: 'POST' | 'GET';
  /** 'form' = application/x-www-form-urlencoded  |  'json' = application/json */
  contentType?: 'form' | 'json';
  /**
   * Corps de la requête de login.
   * Placeholders supportés : {{username}}, {{password}},
   * et {{nomClé}} pour les valeurs extraites dans preStep (ex: {{_csrf}}).
   */
  body: Record<string, string>;
  /** Étape optionnelle pour récupérer un CSRF token avant de poster les credentials */
  preStep?: PreLoginStep;
  /**
   * Chaînes HTML dont la présence indique un échec de login.
   * Vérifiées après le login ET après chaque fetch (session expirée).
   */
  failurePatterns: string[];
}

export interface FieldExtractor {
  // JSON : chemin dot-notation  ex: "response.stats.uploaded"
  path?: string;
  // HTML : regex avec groupe nommé (?<value>...)
  regex?: string;
  transform?: 'bytes' | 'number' | 'integer' | 'string';
}

export interface FetchStep {
  url: string;
  mode?: 'http' | 'browser';
  responseType: 'json' | 'html';
  fields: Record<string, FieldExtractor>;
}

export interface TrackerConfig {
  id: string;
  name: string;
  baseUrl: string;
  enabled?: boolean;
  /** Tracker sans systeme de ratio (HD-Only, Nostradamus, etc.) */
  ratioless?: boolean;
  login: LoginConfig;
  fetch: FetchStep;
  dashboard?: {
    byteUnit?: 'binary' | 'decimal';
  };
}

export interface AppConfig {
  refreshInterval?: number; // minutes, défaut 15
  trackers: TrackerConfig[];
}

/** credentials.json — séparé de trackers.json, à gitignorer */
export type Credentials = Record<string, { username: string; password: string }>;

// ─── Runtime ─────────────────────────────────────────────────────────────────

export interface TrackerStats {
  id: string;
  name: string;
  trackerUrl?: string;
  status: 'ok' | 'error';
  error?: string;
  /** Resultat d'un ping HTTP sur baseUrl — false = site injoignable (DNS/TCP/TLS/proxy KO) */
  siteReachable?: boolean;
  lastUpdated: string;
  lastLoginAt?: string;
  byteUnit: 'binary' | 'decimal';
  fields: Record<string, string | number>;
}
