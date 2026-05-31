import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { fetchTracker, invalidateAllSessions, invalidateSession } from './fetcher.js';
import { resetBrowserProfile, closeBrowserSession } from './browserFetcher.js';
import { type FieldExtractor, type TrackerConfig, type TrackerStats } from './types.js';
import {
  loadProxySettings, saveProxySettings, buildProxyConfig, logProxyStatus,
  loadProxyOverrides, saveProxyOverrides,
  type ProxySettings, type ProxyOverride,
} from './proxy.js';
import crypto from 'crypto';
import {
  loadIncidents, setIncident, getIncident, clearIncident,
} from './incidents.js';
import {
  resolveLogoPath, refreshAllLogos, listTrackersWithoutLogo,
} from './logos.js';
import {
  ensureTrackerSchedules,
  deleteTrackerCredentials,
  getTrackerCredentials,
  getTrackerSchedule,
  importLegacyCredentialsIfNeeded,
  importLegacySettingsIfNeeded,
  importLegacyTrackersIfNeeded,
  getJsonSetting,
  listTrackerCredentialSummaries,
  listTrackerDefinitionFiles,
  listTrackerSchedules,
  loadCredentialsFromDb,
  loadTrackerConfigsFromDb,
  loadTrackerDefinitionFile,
  markTrackerScheduleRun,
  saveStatSnapshots,
  saveTrackerCredentials,
  saveTrackerConfig,
  saveTrackerSchedule,
  setJsonSetting,
  hasTrackerCookie,
  setTrackerCookie,
} from './db.js';
import {
  createSessionCookie,
  isAuthConfigured,
  readCookie,
  saveAuthSettings,
  verifyLogin,
  verifySessionCookie,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const SESSION_COOKIE = 'tracker_dashboard_session';
const TRACKER_DEFINITIONS_SEEN_KEY = 'trackerDefinitionsSeen';
const PRESENTATION_MODE_KEY = 'presentationMode';

// ─── Chargement trackers / credentials ───────────────────────────────────────

// ─── State ────────────────────────────────────────────────────────────────────

let cachedStats: TrackerStats[] = [];
let lastRefresh: string | null  = null;
let isRefreshing                = false;
const pendingScheduledRuns = new Set<string>();

const unit3dFields = knownUnit3dFields();

function knownUnit3dFields(): Record<string, FieldExtractor> {
  return {
    uploadedBytes: {
      regex: 'ratio-bar__uploaded[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
      transform: 'bytes',
    },
    downloadedBytes: {
      regex: 'ratio-bar__downloaded[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
      transform: 'bytes',
    },
    ratio: {
      regex: 'ratio-bar__ratio[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+)',
      transform: 'number',
    },
    seeding: {
      regex: 'ratio-bar__seeding[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>\\d+)',
      transform: 'integer',
    },
    leeching: {
      regex: 'ratio-bar__leeching[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>\\d+)',
      transform: 'integer',
    },
    seedBonus: {
      regex: 'ratio-bar__points[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,\\u202f]+)',
      transform: 'string',
    },
    bufferBytes: {
      regex: 'ratio-bar__buffer[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
      transform: 'bytes',
    },
    tokens: {
      regex: 'ratio-bar__tokens[\\s\\S]*?<i[^>]*>[\\s\\S]*?</i>\\s*(?<value>\\d+)',
      transform: 'integer',
    },
  };
}

const knownTrackerFields: Record<string, {
  fetchUrl?: string;
  mode?: 'http' | 'browser';
  byteUnit?: 'binary' | 'decimal';
  ratioless?: boolean;
  fields: Record<string, FieldExtractor>;
}> = {
  hdonly: {
    fetchUrl: 'index.php',
    byteUnit: 'decimal',
    ratioless: true,
    fields: {
      uploadedBytes: {
        regex: 'Envoy[\\s\\S]{0,160}?(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'Re[\\s\\S]{0,160}?(?<value>[\\d\\s.,]+\\s*[KMGTPE]?i?B)',
        transform: 'bytes',
      },
    },
  },
  hdforever: {
    fetchUrl: 'index.php',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: 'Envoy[ée]\\s*:[\\s\\S]{0,160}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'Re[çc]u\\s*:[\\s\\S]{0,160}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))',
        transform: 'bytes',
      },
      ratio: {
        regex: 'Ratio\\s*:[\\s\\S]{0,120}?(?<value>\\d[\\d\\s.,]*)',
        transform: 'number',
      },
      seedBonus: {
        regex: 'Magasin\\s*:[\\s\\S]{0,120}?(?<value>\\d[\\d\\s.,]*)',
        transform: 'string',
      },
    },
  },
  theoldschool: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  generationfree: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  teamflix: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  g3mini: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  seedpool: {
    fetchUrl: '/',
    byteUnit: 'binary',
    fields: unit3dFields,
  },
  abnormal: {
    fetchUrl: '/',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: 'Up\\s*:[\\s\\S]{0,360}?text-green[\\s\\S]{0,120}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B))',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'Down\\s*:[\\s\\S]{0,360}?text-green[\\s\\S]{0,120}?(?<value>[\\d\\s.,]+\\s*(?:[KMGTPE](?:i?B|io|o)|B))',
        transform: 'bytes',
      },
      ratio: {
        regex: 'Ratio\\s*:[\\s\\S]{0,360}?text-green[\\s\\S]{0,120}?(?<value>[\\d\\s.,]+)',
        transform: 'number',
      },
      seedBonus: {
        regex: "Choco's\\s*:[\\s\\S]{0,360}?text-green[\\s\\S]{0,120}?(?<value>[\\d\\s.,]+)",
        transform: 'string',
      },
    },
  },
  nexum: {
    fetchUrl: 'activity',
    mode: 'browser',
    byteUnit: 'binary',
    fields: {
      uploadedBytes: {
        regex: 'user-stat-up[^>]*>[\\s\\S]*?(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</span>',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'user-stat-dn[^>]*>[\\s\\S]*?(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</span>',
        transform: 'bytes',
      },
      seedBonus: {
        regex: 'class=["\']val["\'][\\s\\S]{0,160}?(?<value>\\d[\\d\\s.,]*)[\\s\\S]{0,160}?Points bonus',
        transform: 'string',
      },
      seeding: {
        regex: 'Seeds\\s*\\((?<value>\\d+)\\)',
        transform: 'integer',
      },
    },
  },
  yggreborn: {
    fetchUrl: 'account/',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: '(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</div>[\\s\\S]{0,180}?>Upload<',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: '(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*</div>[\\s\\S]{0,180}?>Download<',
        transform: 'bytes',
      },
    },
  },
  tr4ker: {
    fetchUrl: '/',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      ratio: {
        regex: 'RATIO\\s*:?\\s*(?<value>[\\d\\s.,]+)',
        transform: 'number',
      },
      uploadedBytes: {
        regex: '>UPLOAD<[\\s\\S]{0,180}?_statValue[^>]*>\\s*(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*<',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: '>DOWNLOAD<[\\s\\S]{0,180}?_statValue[^>]*>\\s*(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*<',
        transform: 'bytes',
      },
    },
  },
  lacale: {
    fetchUrl: 'profile',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: '\\\\?"uploaded\\\\?"\\s*:\\s*(?<value>\\d+)',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: '\\\\?"downloaded\\\\?"\\s*:\\s*(?<value>\\d+)',
        transform: 'bytes',
      },
      seedBonus: {
        regex: '\\\\?"bonusPoints\\\\?"\\s*:\\s*(?<value>\\d+)',
        transform: 'string',
      },
    },
  },
  crazyspirits: {
    fetchUrl: '/',
    mode: 'browser',
    byteUnit: 'binary',
    fields: {
      downloadedBytes: {
        regex: '/dl\\.png"[\\s\\S]{0,160}?<font[^>]*>\\s*(?<value>[\\d.,]+\\s*[KMGTPE]?i?B)',
        transform: 'bytes',
      },
      uploadedBytes: {
        regex: '/up\\.png"[\\s\\S]{0,160}?<font[^>]*>\\s*(?<value>[\\d.,]+\\s*[KMGTPE]?i?B)',
        transform: 'bytes',
      },
      seedBonus: {
        regex: 'Crazy Bonus\\s*<a[^>]*>\\s*(?<value>[\\d\\s.,]+)',
        transform: 'string',
      },
    },
  },
  c411: {
    fetchUrl: 'user/profile',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      uploadedBytes: {
        regex: '(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))[\\s\\S]{0,260}?Envoy',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: '(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))[\\s\\S]{0,260}?T(?:élé|ele|[ée]l[ée])charg',
        transform: 'bytes',
      },
    },
  },
  torr9: {
    fetchUrl: 'stats',
    mode: 'browser',
    byteUnit: 'decimal',
    fields: {
      ratio: {
        regex: 'Ratio[\\s\\S]{0,320}?>\\s*(?<value>\\d[\\d\\s.,]*)\\s*<',
        transform: 'number',
      },
      uploadedBytes: {
        regex: 'Upload total[\\s\\S]{0,420}?>\\s*(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)))\\s*<',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: 'Download total[\\s\\S]{0,420}?>\\s*(?<value>\\d[\\d\\s.,]*\\s*(?:[KMGTPE](?:i?B|io|o)))\\s*<',
        transform: 'bytes',
      },
      seedBonus: {
        regex: 'Score\\s*(?<value>[\\d\\s.,]+)',
        transform: 'string',
      },
    },
  },
  nostradamus: {
    fetchUrl: 'activity',
    mode: 'browser',
    byteUnit: 'decimal',
    ratioless: true,
    fields: {
      uploadedBytes: {
        regex: '>\\s*Upload total\\s*<[\\s\\S]{0,400}?>\\s*(?<value>\\d[\\d.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*<',
        transform: 'bytes',
      },
      downloadedBytes: {
        regex: '>\\s*Download total\\s*<[\\s\\S]{0,400}?>\\s*(?<value>\\d[\\d.,]*\\s*(?:[KMGTPE](?:i?B|io|o)|B|o))\\s*<',
        transform: 'bytes',
      },
      points: {
        regex: 'hero-banknotes[\\s\\S]*?sidebar-account-stat__value[^>]*>\\s*(?<value>[\\d\\s.,]+)',
        transform: 'integer',
      },
      rate: {
        regex: 'hero-bolt[\\s\\S]*?sidebar-account-stat__value[^>]*>\\s*(?<value>[\\d\\s.,]+)',
        transform: 'number',
      },
    },
  },
};

function normalizeTrackerConfigs(): TrackerConfig[] {
  const trackers = loadTrackerConfigsFromDb();
  for (const tracker of trackers) {
    let changed = false;
    const isHdOnlyLikeTracker = ['hdonly', 'hdforever'].includes(tracker.id);
    const isUnit3dTracker = ['theoldschool', 'generationfree', 'teamflix', 'g3mini', 'seedpool'].includes(tracker.id);
    if (tracker.id === 'hdonly' && tracker.login.failurePatterns.includes('login.php')) {
      tracker.login.failurePatterns = tracker.login.failurePatterns
        .filter(pattern => pattern !== 'login.php');
      changed = true;
    }
    if (isHdOnlyLikeTracker) {
      tracker.login.preStep = {
        url: 'login.php',
        extract: {},
        includeHiddenInputs: true,
      };
      tracker.login.failurePatterns = [
        ...new Set([
          ...tracker.login.failurePatterns,
          'type="password"',
          'href="login.php"',
          'Entrer</a>',
        ]),
      ];
      changed = true;
    }
    if (isUnit3dTracker) {
      tracker.login.preStep = {
        ...(tracker.login.preStep ?? { url: 'login', extract: {} }),
        includeHiddenInputs: true,
      };
      tracker.login.body = {
        _token: '{{_csrf}}',
        username: '{{username}}',
        password: '{{password}}',
        remember: 'on',
      };
      tracker.login.failurePatterns = [
        ...new Set([
          ...tracker.login.failurePatterns,
          'auth-form__form',
          'type="password"',
          'Se connecter',
        ]),
      ];
      changed = true;
    }
    if (tracker.id === 'abnormal') {
      if (tracker.login.url !== 'Home/Login') {
        tracker.login.url = 'Home/Login';
        changed = true;
      }
      tracker.login.preStep = {
        ...(tracker.login.preStep ?? { url: 'Home/Login', extract: {} }),
        url: 'Home/Login',
        includeHiddenInputs: true,
      };
      tracker.login.failurePatterns = [
        ...new Set([
          ...tracker.login.failurePatterns,
          'id="account"',
          'type="password"',
          'Connexion - ABN',
        ]),
      ];
      changed = true;
    }
    if (tracker.id === 'nostradamus') {
      if (tracker.login.url !== 'sign-in') {
        tracker.login.url = 'sign-in';
      }
      tracker.login.body = {
        password: '{{password}}',
      };
      tracker.login.failurePatterns = [
        'type="password"',
        'private-key-input',
        'name="password"',
        'name="username"',
        'Se connecter',
      ];
      changed = true;
    }
    if (tracker.id === 'tr4ker') {
      tracker.login.failurePatterns = [
        ...new Set([
          ...tracker.login.failurePatterns,
          'href="/login"',
          'aria-label="Connexion"',
          'Inscription',
        ]),
      ];
      changed = true;
    }
    if (tracker.id === 'torr9') {
      if (tracker.login.url !== 'login?redirect=%2Fstats') {
        tracker.login.url = 'login?redirect=%2Fstats';
      }
      tracker.login.failurePatterns = [
        ...new Set([
          ...tracker.login.failurePatterns,
          'Bon Retour',
          'Nom d\'utilisateur ou adresse mail',
          'type="password"',
          'name="password"',
        ]),
      ];
      changed = true;
    }
    if (tracker.id === 'yggreborn') {
      if (tracker.login.url !== 'login?next=/account/') {
        tracker.login.url = 'login?next=/account/';
      }
      tracker.login.body = {
        identifier: '{{username}}',
        password: '{{password}}',
      };
      tracker.login.failurePatterns = [
        'type="password"',
        'name="password"',
        'name="identifier"',
        'cf-turnstile',
        'Connexion à ton compte',
      ];
      changed = true;
    }
    const known = knownTrackerFields[tracker.id];
    if (known) {
      if (known.mode && tracker.fetch.mode !== known.mode) {
        tracker.fetch.mode = known.mode;
        changed = true;
      }
      if (known.fetchUrl && tracker.fetch.url !== known.fetchUrl) {
        tracker.fetch.url = known.fetchUrl;
        changed = true;
      }
      if (JSON.stringify(tracker.fetch.fields) !== JSON.stringify(known.fields)) {
        tracker.fetch.fields = known.fields;
        changed = true;
      }
      if (known.byteUnit && tracker.dashboard?.byteUnit !== known.byteUnit) {
        tracker.dashboard = { ...(tracker.dashboard ?? {}), byteUnit: known.byteUnit };
        changed = true;
      }
      if (typeof known.ratioless === 'boolean' && tracker.ratioless !== known.ratioless) {
        tracker.ratioless = known.ratioless;
        changed = true;
      }
    }
    if (changed) saveTrackerConfig(tracker);
  }
  return loadTrackerConfigsFromDb();
}

function proxyAllowsTrackerConnections(): boolean {
  const proxy = loadProxySettings();
  const proxyActive = Boolean(proxy.enabled && proxy.host && proxy.port);
  return proxyActive || proxy.directConnectAllowed;
}

function blockedStats(trackers: TrackerConfig[]): TrackerStats[] {
  const error = 'Connexion bloquee : active un proxy ou coche explicitement la connexion directe sans proxy.';
  return trackers
    .filter(t => t.enabled !== false)
    .map(tracker => ({
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'error',
      error,
      lastUpdated: new Date().toISOString(),
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields:      {},
    }));
}

// Compteur de OK consecutifs par tracker (en memoire) pour l'auto-lever d'incident.
// Reset au redemarrage = conservateur (on garde l'incident plus longtemps), ce qui est voulu.
const incidentOkStreaks = new Map<string, number>();
const INCIDENT_AUTO_CLEAR_AFTER = 2; // nb de fetchs OK consecutifs avant auto-lever

/**
 * Effet de bord : gere le compteur de OK consecutifs et leve l'incident apres
 * INCIDENT_AUTO_CLEAR_AFTER fetchs OK d'affilee. Toute erreur remet le compteur a zero.
 * A appeler EXACTEMENT UNE FOIS par tracker et par cycle de refresh (sinon le compteur
 * monte trop vite et leve un incident sur un seul vrai OK).
 */
function processIncidentStreak(stat: TrackerStats): void {
  const incident = getIncident(stat.id);
  if (!incident) {
    incidentOkStreaks.delete(stat.id);
    return;
  }
  if (stat.status === 'ok') {
    const streak = (incidentOkStreaks.get(stat.id) ?? 0) + 1;
    if (streak >= INCIDENT_AUTO_CLEAR_AFTER) {
      clearIncident(stat.id);
      incidentOkStreaks.delete(stat.id);
      console.log(`[Incident] ${stat.name} : ${INCIDENT_AUTO_CLEAR_AFTER} OK consecutifs -> incident leve automatiquement`);
    } else {
      incidentOkStreaks.set(stat.id, streak);
    }
  } else {
    // Une erreur casse la serie : on repart de zero
    incidentOkStreaks.delete(stat.id);
  }
}

/**
 * Pur (aucun effet de bord) : attache l'incident a la stat pour l'affichage.
 * Sur une stat OK, on n'attache rien (la carte verte n'affiche pas de badge incident).
 */
function attachIncident(stat: TrackerStats): TrackerStats {
  if (stat.status === 'ok') return stat;
  const incident = getIncident(stat.id);
  if (!incident) return stat;
  return { ...stat, incident: { acknowledged: incident.acknowledged, note: incident.note } };
}

function upsertCachedStat(stat: TrackerStats): void {
  const annotated = attachIncident(stat);
  cachedStats = [
    ...cachedStats.filter(existing => existing.id !== annotated.id),
    annotated,
  ];
  lastRefresh = new Date().toISOString();
}

function visibleStats(trackers: TrackerConfig[]): TrackerStats[] {
  const cached = new Map(cachedStats.map(stat => [stat.id, stat]));
  return trackers
    .filter(tracker => tracker.enabled !== false)
    .map(tracker => cached.get(tracker.id) ?? ({
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'error',
      error:       'En attente du premier rafraichissement',
      lastUpdated: new Date().toISOString(),
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields:      {},
    }));
}

function logStatResult(stat: TrackerStats): void {
  if (stat.status === 'ok') {
    const fields = Object.entries(stat.fields)
      .filter(([, value]) => value !== '' && value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${value}`);
    console.log(`  [${stat.name}] Stats OK${fields.length ? ` (${fields.join(', ')})` : ' (aucune donnee extraite)'}`);
    return;
  }

  console.log(`  [${stat.name}] Stats ERREUR - ${stat.error ?? 'Erreur inconnue'}`);
}

function isPresentationMode(): boolean {
  return Boolean(getJsonSetting(PRESENTATION_MODE_KEY, { enabled: false }).enabled);
}

function fakeNumber(seed: number, min: number, max: number): number {
  const value = Math.sin(seed * 9301 + 49297) * 233280;
  const normalized = value - Math.floor(value);
  return min + normalized * (max - min);
}

function fakeStatsForPresentation(): TrackerStats[] {
  const now = new Date();
  const ratiolessIds = new Set(['hdonly', 'nostradamus']);
  return listTrackerDefinitionFiles()
    .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }))
    .map((tracker, index) => {
      const uploadedBytes = Math.round(fakeNumber(index + 1, 80, 8200) * 1024 ** 3);
      const ratio = Number(fakeNumber(index + 7, 1.35, 38).toFixed(2));
      const downloadedBytes = Math.max(1, Math.round(uploadedBytes / ratio));
      const bufferBytes = uploadedBytes - downloadedBytes;
      const lastLoginAt = new Date(now.getTime() - fakeNumber(index + 11, 1, 96) * 3600_000).toISOString();
      const isRatioless = ratiolessIds.has(tracker.id);

      const fields: Record<string, string | number> = {
        uploadedBytes,
        downloadedBytes,
        ratio,
        bufferBytes,
      };

      if (isRatioless) {
        fields.points = Math.round(fakeNumber(index + 17, 50, 5200));
        fields.rate = Number(fakeNumber(index + 23, 0, 320).toFixed(1));
      } else {
        fields.seeding = Math.round(fakeNumber(index + 17, 0, 42));
        fields.seedBonus = index % 4 === 1
          ? ''
          : Math.round(fakeNumber(index + 23, 250, 185000)).toLocaleString('fr-FR');
      }

      return {
        id: tracker.id,
        name: tracker.name,
        trackerUrl: tracker.baseUrl,
        status: 'ok',
        lastUpdated: now.toISOString(),
        lastLoginAt,
        byteUnit: 'binary',
        fields,
      };
    });
}

// Nombre de trackers rafraichis en parallele. Au-dela, le navigateur headless sature
// (chaque tracker en mode browser lance un Chromium). 3 = bon compromis vitesse/charge.
// Surchargeable via la variable d'env REFRESH_CONCURRENCY.
const REFRESH_CONCURRENCY = Math.max(1, Number(process.env.REFRESH_CONCURRENCY) || 3);

/**
 * Applique `fn` a tous les items avec au plus `limit` executions simultanees.
 * Preserve l'ordre des resultats. Ne rejette jamais (fn doit gerer ses erreurs).
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const pool = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(pool);
  return results;
}

async function refresh(trackers: TrackerConfig[]): Promise<void> {
  if (isRefreshing) return;
  isRefreshing = true;
  console.log(`\n[${new Date().toISOString()}] Refresh...`);
  try {
    if (isPresentationMode()) {
      cachedStats = fakeStatsForPresentation();
      lastRefresh = new Date().toISOString();
      console.log('  Mode presentation actif - donnees factices');
      return;
    }

    if (!proxyAllowsTrackerConnections()) {
      cachedStats = blockedStats(trackers);
      lastRefresh = new Date().toISOString();
      console.warn('  Connexions trackers bloquees : proxy absent et connexion directe non autorisee');
      return;
    }

    const credentials = loadCredentialsFromDb();
    const enabledTrackers = trackers.filter(t => t.enabled !== false);
    const results = await mapWithConcurrency(enabledTrackers, REFRESH_CONCURRENCY, async tracker => {
      const creds = credentials[tracker.id];
      if (!creds) {
        const stat: TrackerStats = {
          id:          tracker.id,
          name:        tracker.name,
          trackerUrl:  tracker.baseUrl,
          status:      'error',
          error:       `Credentials manquants pour "${tracker.id}"`,
          lastUpdated: new Date().toISOString(),
          byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
          fields:      {},
        };
        upsertCachedStat(stat);
        logStatResult(stat);
        return stat;
      }

      const stat = await fetchTracker(tracker, creds);
      processIncidentStreak(stat); // une fois par tracker par cycle
      upsertCachedStat(stat);
      logStatResult(stat);
      return stat;
    });
    cachedStats = results.map(attachIncident);
    lastRefresh = new Date().toISOString();
    saveStatSnapshots(cachedStats);
    const ok  = cachedStats.filter(s => s.status === 'ok').length;
    const err = cachedStats.filter(s => s.status === 'error').length;
    console.log(`  ✅ ${ok} ok  ❌ ${err} erreur(s)`);
    cachedStats.filter(s => s.status === 'error')
      .forEach(s => console.log(`  ⚠️  ${s.name}: ${s.error}`));
  } finally {
    isRefreshing = false;
  }
}

async function refreshOneTracker(
  tracker: TrackerConfig,
): Promise<TrackerStats> {
  if (isPresentationMode()) {
    const stat = fakeStatsForPresentation().find(item => item.id === tracker.id);
    if (stat) return stat;
  }

  if (!proxyAllowsTrackerConnections()) {
    const stat = blockedStats([tracker])[0];
    upsertCachedStat(stat);
    logStatResult(stat);
    return stat;
  }

  const creds = loadCredentialsFromDb()[tracker.id];
  if (!creds) {
    const stat: TrackerStats = {
      id:          tracker.id,
      name:        tracker.name,
      trackerUrl:  tracker.baseUrl,
      status:      'error',
      error:       `Credentials manquants pour "${tracker.id}"`,
      lastUpdated: new Date().toISOString(),
      byteUnit:    tracker.dashboard?.byteUnit ?? 'binary',
      fields:      {},
    };
    upsertCachedStat(stat);
    logStatResult(stat);
    return stat;
  }

  const stat = await fetchTracker(tracker, creds);
  processIncidentStreak(stat); // une fois par tracker par cycle
  upsertCachedStat(stat);
  logStatResult(stat);
  saveStatSnapshots([stat]);
  return stat;
}


// ─── Serveur ──────────────────────────────────────────────────────────────────

function nextRandomRun(intervalHours: number): string {
  const next = new Date();
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() + Math.max(1, Math.round(intervalHours / 24)));
  next.setHours(
    Math.floor(Math.random() * 24),
    Math.floor(Math.random() * 60),
    Math.floor(Math.random() * 60),
    0,
  );
  return next.toISOString();
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function randomSpacingMs(): number {
  return (10 + Math.floor(Math.random() * 81)) * 1000;
}

async function refreshScheduledTracker(
  tracker: TrackerConfig,
): Promise<void> {
  if (isRefreshing) return;
  if (!proxyAllowsTrackerConnections()) {
    console.warn(`  [${tracker.name}] Refresh planifie bloque : proxy absent et connexion directe non autorisee`);
    return;
  }

  const creds = loadCredentialsFromDb()[tracker.id];
  if (!creds) {
    console.warn(`  [${tracker.name}] Refresh planifie ignore : credentials manquants`);
    return;
  }

  const schedule = getTrackerSchedule(tracker.id);
  const intervalHours = schedule?.intervalHours ?? 24;
  const stat = await fetchTracker(tracker, creds);
  upsertCachedStat(stat);
  logStatResult(stat);
  saveStatSnapshots([stat]);
  markTrackerScheduleRun(tracker.id, nextRandomRun(intervalHours));
}

function startScheduler(): void {
  setInterval(() => {
    const trackers = loadTrackerConfigsFromDb();
    const now = Date.now();
    const schedules = listTrackerSchedules().filter(schedule => {
      if (!schedule.enabled || !schedule.nextRunAt) return false;
      return new Date(schedule.nextRunAt).getTime() <= now;
    });

    let delay = 0;
    for (const schedule of shuffled(schedules)) {
      if (pendingScheduledRuns.has(schedule.trackerId)) continue;
      const tracker = trackers.find(t => t.id === schedule.trackerId && t.enabled !== false);
      if (!tracker) continue;
      pendingScheduledRuns.add(schedule.trackerId);
      delay += randomSpacingMs();
      setTimeout(() => {
        refreshScheduledTracker(tracker)
          .catch(err => {
            console.error(`[${tracker.name}] Refresh planifie en erreur :`, err);
          })
          .finally(() => {
            pendingScheduledRuns.delete(schedule.trackerId);
          });
      }, delay);
    }
  }, 60_000);
}

// ─── Prometheus metrics ───────────────────────────────────────────────────────

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = parseFloat(value.replace(/[\s ]/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function renderPrometheusMetrics(stats: TrackerStats[]): string {
  const definitions: Array<{ name: string; help: string; type: 'gauge' | 'counter'; pick: (s: TrackerStats) => number | null }> = [
    { name: 'tracker_uploaded_bytes_total',   help: 'Cumulative uploaded bytes', type: 'counter', pick: s => toNumber(s.fields.uploadedBytes) },
    { name: 'tracker_downloaded_bytes_total', help: 'Cumulative downloaded bytes', type: 'counter', pick: s => toNumber(s.fields.downloadedBytes) },
    { name: 'tracker_ratio',            help: 'Ratio (scraped or computed up/down)', type: 'gauge', pick: s => {
        const r = toNumber(s.fields.ratio);
        if (r !== null) return r;
        const up = toNumber(s.fields.uploadedBytes);
        const down = toNumber(s.fields.downloadedBytes);
        if (up === null || down === null) return null;
        if (down === 0) return up > 0 ? Number.POSITIVE_INFINITY : 0;
        return up / down;
      } },
    { name: 'tracker_buffer_bytes', help: 'Buffer = uploaded - downloaded (scraped if present)', type: 'gauge', pick: s => {
        const b = toNumber(s.fields.bufferBytes);
        if (b !== null) return b;
        const up = toNumber(s.fields.uploadedBytes);
        const down = toNumber(s.fields.downloadedBytes);
        if (up === null || down === null) return null;
        return up - down;
      } },
    { name: 'tracker_seed_bonus',     help: 'Bonus points', type: 'gauge', pick: s => toNumber(s.fields.seedBonus) },
    { name: 'tracker_seeding_count',  help: 'Active seeding torrents', type: 'gauge', pick: s => toNumber(s.fields.seeding) },
    { name: 'tracker_leeching_count', help: 'Active leeching torrents', type: 'gauge', pick: s => toNumber(s.fields.leeching) },
    { name: 'tracker_points',         help: 'Points (ratioless trackers)', type: 'gauge', pick: s => toNumber(s.fields.points) },
    { name: 'tracker_rate_per_day',   help: 'Points earned per day (ratioless)', type: 'gauge', pick: s => toNumber(s.fields.rate) },
    { name: 'tracker_tokens',         help: 'Freeleech tokens', type: 'gauge', pick: s => toNumber(s.fields.tokens) },
    { name: 'tracker_up',             help: '1 if last fetch succeeded, 0 if error', type: 'gauge', pick: s => s.status === 'ok' ? 1 : 0 },
    { name: 'tracker_site_reachable', help: '1 if last ping succeeded, 0 if failed, absent if not measured', type: 'gauge', pick: s => s.siteReachability ? (s.siteReachability.reachable ? 1 : 0) : null },
    { name: 'tracker_last_update_timestamp_seconds', help: 'Unix timestamp of last refresh', type: 'gauge', pick: s => {
        const t = Date.parse(s.lastUpdated);
        return Number.isFinite(t) ? Math.floor(t / 1000) : null;
      } },
  ];

  const lines: string[] = [];
  for (const def of definitions) {
    lines.push(`# HELP ${def.name} ${def.help}`);
    lines.push(`# TYPE ${def.name} ${def.type}`);
    for (const stat of stats) {
      const value = def.pick(stat);
      if (value === null) continue;
      const labels = `tracker="${escapeLabel(stat.id)}",name="${escapeLabel(stat.name)}"`;
      const printable = Number.isFinite(value) ? value : (value > 0 ? '+Inf' : '-Inf');
      lines.push(`${def.name}{${labels}} ${printable}`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function start(): Promise<void> {
  importLegacySettingsIfNeeded();
  importLegacyCredentialsIfNeeded();
  importLegacyTrackersIfNeeded();
  let trackers = normalizeTrackerConfigs();
  ensureTrackerSchedules(trackers);

  const app = express();
  app.use(express.json());

  app.get('/login.html', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  app.get('/logo.png', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'logo.png'));
  });

  app.get('/api/auth/status', (req, res) => {
    res.json({
      configured: isAuthConfigured(),
      authenticated: verifySessionCookie(readCookie(req.headers.cookie, SESSION_COOKIE)),
    });
  });

  app.post('/api/auth/setup', (req, res) => {
    if (isAuthConfigured()) return res.status(409).json({ ok: false, error: 'Compte deja configure' });
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password || password.length < 8) {
      return res.status(400).json({ ok: false, error: 'Utilisateur et mot de passe de 8 caracteres minimum requis' });
    }
    saveAuthSettings(username, password);
    const session = createSessionCookie(username);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`);
    res.json({ ok: true });
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };
    if (!username || !password || !verifyLogin(username, password)) {
      return res.status(401).json({ ok: false, error: 'Identifiants invalides' });
    }
    const session = createSessionCookie(username);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=1209600`);
    res.json({ ok: true });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    res.json({ ok: true });
  });

  // ── Prometheus /metrics (token, hors session) ──────────────────────────────
  app.get('/metrics', (req, res) => {
    const token = process.env.METRICS_TOKEN;
    if (!token) {
      res.status(503).type('text/plain').send('METRICS_TOKEN env var not set on the server');
      return;
    }
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${token}`) {
      res.status(401).type('text/plain').send('Unauthorized');
      return;
    }
    res.type('text/plain; version=0.0.4; charset=utf-8').send(renderPrometheusMetrics(cachedStats));
  });

  app.use((req, res, next) => {
    if (!isAuthConfigured()) {
      if (req.path.startsWith('/api/')) {
        return res.status(401).json({ ok: false, error: 'Compte admin non configure' });
      }
      return res.redirect('/login.html');
    }
    if (verifySessionCookie(readCookie(req.headers.cookie, SESSION_COOKIE))) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'Authentification requise' });
    }
    return res.redirect('/login.html');
  });

  app.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // ── Stats ──────────────────────────────────────────────────────────────────
  app.get('/api/stats', (_req, res) => {
    if (isPresentationMode()) {
      return res.json({
        stats: fakeStatsForPresentation(),
        lastRefresh: new Date().toISOString(),
        isRefreshing: false,
        presentationMode: true,
      });
    }
    trackers = normalizeTrackerConfigs();
    res.json({ stats: visibleStats(trackers), lastRefresh, isRefreshing });
  });

  app.post('/api/refresh', (_req, res) => {
    trackers = normalizeTrackerConfigs();
    if (isPresentationMode()) {
      cachedStats = fakeStatsForPresentation();
      lastRefresh = new Date().toISOString();
      return res.json({ ok: true, presentationMode: true });
    }
    refresh(trackers);
    res.json({ ok: true });
  });

  app.post('/api/refresh/:trackerId', async (req, res) => {
    trackers = normalizeTrackerConfigs();
    if (isPresentationMode()) {
      const stat = fakeStatsForPresentation().find(item => item.id === req.params.trackerId);
      if (!stat) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });
      return res.json({ ok: true, stat, presentationMode: true });
    }
    const tracker = trackers.find(t => t.id === req.params.trackerId && t.enabled !== false);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });
    const stat = await refreshOneTracker(tracker);
    res.json({ ok: true, stat });
  });

  app.get('/api/config', (_req, res) => {
    trackers = normalizeTrackerConfigs();
    const schedules = new Map(listTrackerSchedules().map(s => [s.trackerId, s]));
    const safe = trackers.map(({ id, name, baseUrl, enabled, dashboard, ratioless }) => ({
      id,
      name,
      baseUrl,
      enabled: enabled !== false,
      byteUnit: dashboard?.byteUnit ?? 'binary',
      ratioless: Boolean(ratioless),
      schedule: schedules.get(id) ?? null,
    }));
    res.json({ trackers: safe });
  });

  app.get('/api/trackers', (_req, res) => {
    trackers = normalizeTrackerConfigs();
    res.json({ trackers });
  });

  app.get('/api/tracker-definitions', (_req, res) => {
    importLegacyTrackersIfNeeded();
    trackers = normalizeTrackerConfigs();
    ensureTrackerSchedules(trackers);
    const configured = new Map(trackers.map(tracker => [tracker.id, tracker]));
    const definitions = listTrackerDefinitionFiles()
      .map(definition => {
        const configuredTracker = configured.get(definition.id);
        return {
          ...definition,
          enabled: Boolean(configuredTracker && configuredTracker.enabled !== false),
          configured: Boolean(configuredTracker),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    const seen = getJsonSetting(TRACKER_DEFINITIONS_SEEN_KEY, { ids: [] as string[] });
    const seenIds = new Set(Array.isArray(seen.ids) ? seen.ids : []);
    res.json({
      definitions,
      newDefinitions: definitions.filter(definition => !definition.configured && !seenIds.has(definition.id)),
    });
  });

  app.post('/api/tracker-definitions/seen', (_req, res) => {
    const ids = listTrackerDefinitionFiles().map(definition => definition.id);
    setJsonSetting(TRACKER_DEFINITIONS_SEEN_KEY, { ids });
    res.json({ ok: true });
  });

  app.post('/api/trackers/:trackerId/enabled', (req, res) => {
    importLegacyTrackersIfNeeded();
    trackers = normalizeTrackerConfigs();
    const tracker = trackers.find(t => t.id === req.params.trackerId)
      ?? loadTrackerDefinitionFile(req.params.trackerId);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });

    tracker.enabled = Boolean(req.body.enabled);
    saveTrackerConfig(tracker);
    trackers = normalizeTrackerConfigs();
    ensureTrackerSchedules(trackers);
    res.json({ ok: true, tracker });
  });

  app.post('/api/trackers', (req, res) => {
    try {
      const config = req.body as TrackerConfig;
      if (!config.id || !config.name || !config.baseUrl || !config.login || !config.fetch) {
        return res.status(400).json({ ok: false, error: 'Config tracker incomplete' });
      }
      saveTrackerConfig(config);
      trackers = loadTrackerConfigsFromDb();
      ensureTrackerSchedules(trackers);
      res.json({ ok: true, tracker: config });
    } catch (err: unknown) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ── Proxy settings ─────────────────────────────────────────────────────────
  app.get('/api/settings/presentation', (_req, res) => {
    res.json(getJsonSetting(PRESENTATION_MODE_KEY, { enabled: false }));
  });

  app.post('/api/settings/presentation', (req, res) => {
    const enabled = Boolean(req.body.enabled);
    setJsonSetting(PRESENTATION_MODE_KEY, { enabled });
    if (enabled) {
      cachedStats = fakeStatsForPresentation();
      lastRefresh = new Date().toISOString();
    }
    res.json({ ok: true, enabled });
  });

  app.get('/api/schedules', (_req, res) => {
    res.json({ schedules: listTrackerSchedules() });
  });

  app.get('/api/credentials', (_req, res) => {
    trackers = normalizeTrackerConfigs();
    const credentials = new Map(listTrackerCredentialSummaries().map(c => [c.trackerId, c]));
    const configured = new Map(trackers.map(tracker => [tracker.id, tracker]));
    res.json({
      credentials: listTrackerDefinitionFiles()
        .map(definition => {
          const tracker = configured.get(definition.id);
          return {
            trackerId: definition.id,
            trackerName: definition.name,
            enabled: Boolean(tracker && tracker.enabled !== false),
            configured: Boolean(tracker),
            username: credentials.get(definition.id)?.username ?? '',
            hasPassword: credentials.get(definition.id)?.hasPassword ?? false,
            hasCookie: hasTrackerCookie(definition.id),
            updatedAt: credentials.get(definition.id)?.updatedAt ?? null,
          };
        })
        .sort((a, b) => a.trackerName.localeCompare(b.trackerName, 'fr', { sensitivity: 'base' })),
    });
  });

  app.post('/api/credentials/:trackerId', (req, res) => {
    trackers = loadTrackerConfigsFromDb();
    const tracker = trackers.find(t => t.id === req.params.trackerId)
      ?? loadTrackerDefinitionFile(req.params.trackerId);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });

    const { username, password } = req.body as { username?: string; password?: string };
    const current = getTrackerCredentials(tracker.id);
    const nextUsername = username ?? current?.username ?? '';
    const nextPassword = password === '••••••••' ? current?.password : password;

    if (!nextUsername || !nextPassword) {
      return res.status(400).json({ ok: false, error: 'Utilisateur et mot de passe requis' });
    }

    tracker.enabled = true;
    saveTrackerConfig(tracker);
    saveTrackerCredentials(tracker.id, nextUsername, nextPassword);
    invalidateSession(tracker.id);
    res.json({ ok: true });
  });

  app.delete('/api/credentials/:trackerId', (req, res) => {
    trackers = normalizeTrackerConfigs();
    const tracker = trackers.find(t => t.id === req.params.trackerId)
      ?? loadTrackerDefinitionFile(req.params.trackerId);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });
    deleteTrackerCredentials(tracker.id);
    invalidateSession(tracker.id);
    res.json({ ok: true });
  });

  app.post('/api/schedules/:trackerId', (req, res) => {
    trackers = loadTrackerConfigsFromDb();
    const tracker = trackers.find(t => t.id === req.params.trackerId);
    if (!tracker) return res.status(404).json({ ok: false, error: 'Tracker introuvable' });

    const intervalHours = Number(req.body.intervalHours);
    const allowed = [24, 48, 168, 504];
    if (!allowed.includes(intervalHours)) {
      return res.status(400).json({ ok: false, error: 'Intervalle invalide' });
    }

    const enabled = Boolean(req.body.enabled);
    saveTrackerSchedule(
      tracker.id,
      enabled,
      intervalHours,
      enabled ? nextRandomRun(intervalHours) : null,
    );
    res.json({ ok: true, schedule: getTrackerSchedule(tracker.id) });
  });

  app.get('/api/settings/proxy', (_req, res) => {
    const proxy = loadProxySettings();
    // Ne jamais renvoyer le mot de passe en clair — juste indiquer s'il est défini
    res.json({ ...proxy, password: proxy.password ? '••••••••' : '' });
  });

  app.post('/api/settings/proxy', (req, res) => {
    try {
      const {
        enabled,
        type,
        host,
        port,
        username,
        password,
        directConnectAllowed,
      } = req.body as ProxySettings;
      const current = loadProxySettings();
      const updated: ProxySettings = {
        enabled: Boolean(enabled),
        type:     type     ?? current.type,
        host:     host     ?? current.host,
        port:     port     ?? current.port,
        username: username ?? current.username,
        // Si le client renvoie les bullets, on garde l'ancien password
        password: password === '••••••••' ? current.password : (password ?? current.password),
        directConnectAllowed: Boolean(directConnectAllowed),
      };
      saveProxySettings(updated);
      // Invalider toutes les sessions — elles reprendront avec le nouveau proxy
      invalidateAllSessions();
      console.log(`[Proxy] Config mise à jour — ${updated.enabled ? `${updated.type}://${updated.host}:${updated.port}` : 'désactivé'}`);
      res.json({ ok: true });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Proxy] Impossible de sauvegarder la config :', error);
      res.status(500).json({ ok: false, error });
    }
  });

  // ── Proxies par tracker (overrides) ───────────────────────────────────────
  app.get('/api/settings/proxy-overrides', (_req, res) => {
    // On masque les passwords par des bullets (cote front on differencie ainsi
    // "rien" de "deja defini, ne pas reecrire")
    const sanitized = loadProxyOverrides().map(o => ({
      ...o,
      password: o.password ? '••••••••' : '',
    }));
    res.json({ ok: true, overrides: sanitized });
  });

  app.post('/api/settings/proxy-overrides', (req, res) => {
    try {
      const incoming = req.body?.overrides;
      if (!Array.isArray(incoming)) {
        return res.status(400).json({ ok: false, error: 'Payload invalide — { overrides: [] } attendu' });
      }
      const previous = loadProxyOverrides();
      const previousById = new Map(previous.map(o => [o.id, o]));

      const validTrackerIds = new Set(normalizeTrackerConfigs().map(t => t.id));
      const seenInEnabled = new Map<string, string>(); // trackerId -> overrideLabel

      const cleaned: ProxyOverride[] = [];
      for (const raw of incoming) {
        if (!raw || typeof raw !== 'object') continue;
        const id = typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID();
        const prev = previousById.get(id);
        const passwordIn = typeof raw.password === 'string' ? raw.password : '';
        const override: ProxyOverride = {
          id,
          label:    typeof raw.label === 'string' ? raw.label.trim().slice(0, 64) : '',
          enabled:  Boolean(raw.enabled),
          trackers: Array.isArray(raw.trackers)
            ? Array.from(new Set(raw.trackers.filter((t: unknown): t is string => typeof t === 'string' && validTrackerIds.has(t))))
            : [],
          type:     typeof raw.type === 'string' ? raw.type : 'socks5',
          host:     typeof raw.host === 'string' ? raw.host.trim() : '',
          port:     typeof raw.port === 'string' || typeof raw.port === 'number' ? String(raw.port).trim() : '',
          username: typeof raw.username === 'string' ? raw.username.trim() : '',
          // Si le front renvoie les bullets, on conserve le mot de passe existant
          password: passwordIn === '••••••••' ? (prev?.password ?? '') : passwordIn,
        };

        if (override.enabled) {
          for (const tid of override.trackers) {
            const otherLabel = seenInEnabled.get(tid);
            if (otherLabel !== undefined) {
              return res.status(400).json({
                ok: false,
                error: `Le tracker "${tid}" est cible par plusieurs proxys actifs ("${otherLabel}" et "${override.label || override.id}"). Un tracker ne peut etre couvert que par un seul proxy actif a la fois.`,
              });
            }
            seenInEnabled.set(tid, override.label || override.id);
          }
        }

        cleaned.push(override);
      }

      // Calcul des trackers impactes (info pour logs) : union des trackers cibles AVANT et APRES
      const affected = new Set<string>();
      for (const o of previous) for (const t of o.trackers) affected.add(t);
      for (const o of cleaned)  for (const t of o.trackers) affected.add(t);

      saveProxyOverrides(cleaned);
      // invalidateAllSessions ferme aussi tous les contextes Playwright -
      // pas besoin de fermer individuellement les overrides
      invalidateAllSessions();
      console.log(`[Proxy] Overrides sauves (${cleaned.length}) — sessions invalidees (${affected.size} tracker(s) impactes)`);
      res.json({ ok: true, count: cleaned.length });
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      console.error('[Proxy] Sauvegarde overrides KO :', error);
      res.status(500).json({ ok: false, error });
    }
  });

  // ── Cookie de session manuel (sites a CAPTCHA / Cloudflare Turnstile) ──────
  app.post('/api/trackers/:trackerId/cookie', (req, res) => {
    const id = req.params.trackerId;
    if (!new Set(listTrackerDefinitionFiles().map(t => t.id)).has(id)) {
      return res.status(404).json({ ok: false, error: 'Tracker inconnu' });
    }
    const cookie = typeof req.body?.cookie === 'string' ? req.body.cookie : '';
    setTrackerCookie(id, cookie);
    // Fermer le contexte en memoire pour que le cookie soit (re)injecte au prochain fetch
    closeBrowserSession(id).catch(() => {});
    invalidateSession(id);
    console.log(`[Cookies] ${id} : cookie de session ${cookie.trim() ? 'enregistre' : 'efface'}`);
    res.json({ ok: true, hasCookie: hasTrackerCookie(id) });
  });

  // ── Reset du profil navigateur d'un tracker ───────────────────────────────
  app.post('/api/trackers/:trackerId/reset-profile', async (req, res) => {
    const id = req.params.trackerId;
    if (!new Set(listTrackerDefinitionFiles().map(t => t.id)).has(id)) {
      return res.status(404).json({ ok: false, error: 'Tracker inconnu' });
    }
    try {
      await resetBrowserProfile(id);
      invalidateSession(id); // reset aussi la session HTTP en memoire
      console.log(`[Profil] Profil navigateur de ${id} reinitialise`);
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Logos trackers (favicon en cache + logos manuels) ─────────────────────
  app.get('/api/tracker-logo/:id', (req, res) => {
    const file = resolveLogoPath(req.params.id);
    if (!file) {
      res.status(404).end();
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(file);
  });

  app.get('/api/tracker-logos', (_req, res) => {
    res.json({ ok: true, missing: listTrackersWithoutLogo(listTrackerDefinitionFiles()) });
  });

  app.post('/api/tracker-logos/refresh', async (_req, res) => {
    try {
      const results = await refreshAllLogos(listTrackerDefinitionFiles(), true);
      res.json({ ok: true, results, missing: results.filter(r => !r.ok) });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Incidents trackers (flag manuel) ──────────────────────────────────────
  app.get('/api/incidents', (_req, res) => {
    res.json({ ok: true, incidents: loadIncidents() });
  });

  app.post('/api/incidents/:trackerId', (req, res) => {
    const trackerId = req.params.trackerId;
    const validIds = new Set(normalizeTrackerConfigs().map(t => t.id));
    if (!validIds.has(trackerId)) {
      return res.status(404).json({ ok: false, error: 'Tracker inconnu' });
    }
    const acknowledged = Boolean(req.body?.acknowledged);
    const note = typeof req.body?.note === 'string' ? req.body.note : '';
    const incident = setIncident(trackerId, acknowledged, note);
    // Nouvel incident marque -> on repart d'un compteur de OK vierge (2 OK requis)
    incidentOkStreaks.delete(trackerId);
    // Re-annoter le cache pour que /api/stats reflete immediatement le changement
    const cached = cachedStats.find(s => s.id === trackerId);
    if (cached) upsertCachedStat({ ...cached, incident: undefined });
    res.json({ ok: true, incident });
  });

  app.delete('/api/incidents/:trackerId', (req, res) => {
    clearIncident(req.params.trackerId);
    incidentOkStreaks.delete(req.params.trackerId);
    const cached = cachedStats.find(s => s.id === req.params.trackerId);
    if (cached) upsertCachedStat({ ...cached, incident: undefined });
    res.json({ ok: true });
  });

  app.post('/api/proxy/test', async (req, res) => {
    const { type = 'socks5', host, port, username, password } = req.body as ProxySettings;
    if (!host || !port) return res.status(400).json({ ok: false, error: 'Hôte et port requis' });

    const current = loadProxySettings();
    const cfg = buildProxyConfig({
      enabled: true, type, host, port, username,
      password: password === '••••••••' ? current.password : password,
      directConnectAllowed: current.directConnectAllowed,
    });

    try {
      const r = await axios.get<{ ip: string }>('https://api.ipify.org?format=json', {
        ...cfg, timeout: 8000,
      });
      res.json({ ok: true, ip: r.data.ip });
    } catch (err: unknown) {
      res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  const port = parseInt(process.env.PORT ?? '3000', 10);
  logProxyStatus();
  app.listen(port, () => console.log(`\n🚀  Dashboard → http://localhost:${port}\n`));

  await refresh(trackers);

  // Recuperation automatique des logos au demarrage (non bloquant, FORCE : re-fetch
  // tous les favicons a chaque boot, pour TOUTES les definitions du dossier trackers
  // (actives ou non). Les logos manuels dans config/logos/ restent prioritaires et
  // intacts, et un echec de re-fetch ne supprime pas le logo existant.
  refreshAllLogos(listTrackerDefinitionFiles(), true)
    .then(results => {
      const missing = results.filter(r => !r.ok).map(r => r.id);
      if (missing.length > 0) {
        console.log(`[Logos] Sans favicon auto (deposer un fichier dans config/logos/<id>.png) : ${missing.join(', ')}`);
      }
    })
    .catch(() => { /* best-effort */ });

  startScheduler();
}
