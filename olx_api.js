const axios = require('axios');
const EventEmitter = require('events');

const olxWatchEmitter = new EventEmitter();
const activeOlxWatches = new Map();

function getOlxConfig() {
    const token = process.env.OLX_API_TOKEN || process.env.OLX_TOKEN || process.env.OLX_API_KEY;
    const baseUrl = process.env.OLX_API_BASE_URL || 'https://www.olx.ua/api/v1';
    const searchPath = process.env.OLX_API_SEARCH_PATH || '/offers';
    const infoPath = process.env.OLX_API_INFO_PATH || '/offers/{id}';
    const userAgent = process.env.OLX_API_USER_AGENT || 'CarSearchBot/1.0';
    const appId = process.env.OLX_APP_ID || process.env.OLX_CLIENT_ID || null;
    const hostHeader = process.env.OLX_API_HOST || null;
    const tokenInQuery = String(process.env.OLX_TOKEN_IN_QUERY || '').toLowerCase() === 'true';
    return { token, baseUrl, searchPath, infoPath, userAgent, appId, hostHeader, tokenInQuery };
}

function ensureOlxToken(token) {
    if (token) return;
    throw new Error('Missing OLX token. Set one of: OLX_API_TOKEN, OLX_TOKEN, OLX_API_KEY');
}

function buildHeaders(token, cfg = {}) {
    const headers = {
        Authorization: `Bearer ${token}`,
        'X-API-KEY': token,
        Accept: 'application/json',
        'User-Agent': cfg.userAgent || 'CarSearchBot/1.0'
    };
    if (cfg.appId) headers['X-App-Id'] = cfg.appId;
    if (cfg.hostHeader) headers['Host'] = cfg.hostHeader;
    return headers;
}

function stringifyErrorBody(data) {
    if (!data) return '';
    if (typeof data === 'string') return data;
    try { return JSON.stringify(data); } catch (e) { return String(data); }
}

function isCloudFrontBlocked(status, bodyText, headers) {
    const ct = (headers && (headers['content-type'] || headers['Content-Type'])) || '';
    const t = (bodyText || '').toLowerCase();
    return status === 403 && (
        t.includes('cloudfront') ||
        t.includes('request blocked') ||
        t.includes('the request could not be satisfied') ||
        String(ct).toLowerCase().includes('text/html')
    );
}

function buildOlxBlockedError(originalErr) {
    const hint = 'OLX 403 CloudFront: запит заблоковано. Перевірте правильний OLX API endpoint (OLX_API_BASE_URL/OLX_API_SEARCH_PATH), вимоги до заголовків та whitelist IP для Railway.';
    const e = new Error(hint);
    e.cause = originalErr;
    return e;
}

function buildUrl(baseUrl, path) {
    const b = (baseUrl || '').replace(/\/$/, '');
    const p = (path || '').startsWith('/') ? path : `/${path || ''}`;
    return `${b}${p}`;
}

function extractArrayFromResponse(data) {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    const candidates = [data.data, data.items, data.results, data.offers, data.list, data.ads, data.value];
    for (const c of candidates) {
        if (Array.isArray(c)) return c;
    }
    for (const k of Object.keys(data)) {
        if (Array.isArray(data[k])) return data[k];
    }
    return [];
}

function toNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string') {
        const cleaned = v.replace(/[^\d.,-]/g, '').replace(',', '.');
        const n = Number(cleaned);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function toTimestampMs(v) {
    if (!v && v !== 0) return null;
    if (typeof v === 'number') {
        if (v > 1e12) return v;
        if (v > 1e9) return v * 1000;
        return null;
    }
    if (typeof v === 'string') {
        const maybeN = Number(v);
        if (!Number.isNaN(maybeN)) return toTimestampMs(maybeN);
        const d = Date.parse(v);
        if (!Number.isNaN(d)) return d;
    }
    return null;
}

function normalizeOffer(item) {
    const id = String(
        item.id || item.offer_id || item.ad_id || item.adId || item.uuid || item.slug || ''
    );
    const title = item.title || item.name || item.subject || item.header || 'Без назви';
    const price = toNumber(
        item.price || item.amount || item.price_value || item?.params?.price || item?.salary
    );
    const currency = item.currency || item.currency_code || item?.params?.currency || 'UAH';
    const url = item.url || item.link || item.href || item.web_url || item.permalink || null;
    const location = item.location || item.city || item.region || item.place || item?.address || '';
    const createdAtMs =
        toTimestampMs(item.created_at) ||
        toTimestampMs(item.createdAt) ||
        toTimestampMs(item.published_at) ||
        toTimestampMs(item.publication_date) ||
        toTimestampMs(item.date) ||
        null;

    return {
        id,
        title,
        price,
        currency,
        location: typeof location === 'string' ? location : JSON.stringify(location),
        createdAtMs,
        url,
        raw: item
    };
}

function buildSearchParams({ query = '', region = null, maxPrice = null, minPrice = null, page = 1, limit = 20 } = {}) {
    const p = {
        q: query,
        query,
        page,
        limit,
        per_page: limit
    };
    if (region) {
        p.region = region;
        p.location = region;
    }
    if (maxPrice) {
        p.max_price = maxPrice;
        p.price_to = maxPrice;
    }
    if (minPrice) {
        p.min_price = minPrice;
        p.price_from = minPrice;
    }
    return p;
}

async function searchOlx({ query = '', region = null, maxPrice = null, minPrice = null, page = 1, limit = 20 } = {}) {
    const cfg = getOlxConfig();
    const { token, baseUrl, searchPath } = cfg;
    ensureOlxToken(token);

    const url = buildUrl(baseUrl, searchPath);
    const params = buildSearchParams({ query, region, maxPrice, minPrice, page, limit });
    if (cfg.tokenInQuery) params.api_key = token;

    let res;
    try {
        res = await axios.get(url, {
            headers: buildHeaders(token, cfg),
            params,
            timeout: 20000
        });
    } catch (err) {
        const status = err && err.response && err.response.status;
        const headers = err && err.response && err.response.headers;
        const bodyText = stringifyErrorBody(err && err.response && err.response.data);
        if (isCloudFrontBlocked(status, bodyText, headers)) throw buildOlxBlockedError(err);
        throw err;
    }

    const arr = extractArrayFromResponse(res.data);
    return arr.map(normalizeOffer).filter(x => x.id).slice(0, limit);
}

async function getOlxInfo(id) {
    const cfg = getOlxConfig();
    const { token, baseUrl, infoPath } = cfg;
    ensureOlxToken(token);
    if (!id) return null;

    const path = infoPath.replace('{id}', encodeURIComponent(String(id)));
    const url = buildUrl(baseUrl, path);

    const params = {};
    if (cfg.tokenInQuery) params.api_key = token;

    let res;
    try {
        res = await axios.get(url, {
            headers: buildHeaders(token, cfg),
            params,
            timeout: 20000
        });
    } catch (err) {
        const status = err && err.response && err.response.status;
        const headers = err && err.response && err.response.headers;
        const bodyText = stringifyErrorBody(err && err.response && err.response.data);
        if (isCloudFrontBlocked(status, bodyText, headers)) throw buildOlxBlockedError(err);
        throw err;
    }

    const data = res.data && res.data.data ? res.data.data : res.data;
    return normalizeOffer(data || {});
}

function startOlxWatch({ chatId, query, region = null, maxPrice = null, minPrice = null, intervalSec = 300, limit = 20 }) {
    if (!chatId || !query) return false;
    const key = `${chatId}:${String(query).trim().toLowerCase()}:${region || ''}:${maxPrice || ''}:${minPrice || ''}`;
    if (activeOlxWatches.has(key)) return false;

    const startedAt = Date.now();
    const seen = new Set();
    const safeInterval = Math.max(300, intervalSec || 300);

    const runOnce = async () => {
        const list = await searchOlx({ query, region, maxPrice, minPrice, page: 1, limit });
        for (const item of list) {
            if (!item || !item.id) continue;
            if (seen.has(item.id)) continue;

            const created = item.createdAtMs;
            // Only new ads created after watch start (if date is present)
            if (created && created < startedAt) {
                seen.add(item.id);
                continue;
            }

            seen.add(item.id);
            olxWatchEmitter.emit('new', { chatId, key, item });
        }
    };

    const timer = setInterval(async () => {
        try { await runOnce(); } catch (e) {
            console.error('OLX watch error', e && e.message ? e.message : e);
        }
    }, safeInterval * 1000);

    // Initial warm-up: fill seen without notifications to avoid old flood
    (async () => {
        try {
            const list = await searchOlx({ query, region, maxPrice, minPrice, page: 1, limit });
            for (const item of list) {
                if (item && item.id) seen.add(item.id);
            }
        } catch (e) {
            console.error('OLX watch warmup error', e && e.message ? e.message : e);
        }
    })();

    activeOlxWatches.set(key, {
        timer,
        seen,
        config: { chatId, query, region, maxPrice, minPrice, intervalSec: safeInterval, limit, startedAt }
    });
    return true;
}

function stopOlxWatch({ chatId, query, region = null, maxPrice = null, minPrice = null, key = null }) {
    let k = key;
    if (!k) {
        k = `${chatId}:${String(query || '').trim().toLowerCase()}:${region || ''}:${maxPrice || ''}:${minPrice || ''}`;
    }
    const w = activeOlxWatches.get(k);
    if (!w) return false;
    clearInterval(w.timer);
    activeOlxWatches.delete(k);
    return true;
}

function stopAllOlxWatches(chatId) {
    let stopped = 0;
    for (const [k, v] of activeOlxWatches.entries()) {
        if (v && v.config && String(v.config.chatId) === String(chatId)) {
            clearInterval(v.timer);
            activeOlxWatches.delete(k);
            stopped++;
        }
    }
    return stopped;
}

function listOlxWatches(chatId = null) {
    const out = [];
    for (const [k, v] of activeOlxWatches.entries()) {
        if (chatId !== null && String(v.config.chatId) !== String(chatId)) continue;
        out.push({ key: k, config: v.config });
    }
    return out;
}

module.exports = {
    searchOlx,
    getOlxInfo,
    startOlxWatch,
    stopOlxWatch,
    stopAllOlxWatches,
    listOlxWatches,
    olxWatchEmitter
};
