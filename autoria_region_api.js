
const axios = require('axios');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, 'regions_cache.json');
const AVG_CACHE_FILE = path.join(__dirname, 'avg_cache.json');
const RATE_STATE_FILE = path.join(__dirname, 'rate_state.json');
const RATE_LIMIT = Number(process.env.AUTORIA_RATE_LIMIT) || 30; // requests per hour

let avgCache = {};
try {
    if (fs.existsSync(AVG_CACHE_FILE)) {
        const raw = fs.readFileSync(AVG_CACHE_FILE, 'utf8');
        avgCache = JSON.parse(raw) || {};
    }
} catch (e) {
    avgCache = {};
}

function saveAvgCache() {
    try { fs.writeFileSync(AVG_CACHE_FILE, JSON.stringify(avgCache, null, 2), 'utf8'); } catch (e) {}
}

// Змінна для зберігання областей у пам'яті (кеш)
let cachedRegions = null;
let rateLimitedUntil = null;
let rateState = { windowStart: null, countUsed: 0 };
try {
    if (fs.existsSync(RATE_STATE_FILE)) {
        const raw = fs.readFileSync(RATE_STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') rateState = parsed;
    }
} catch (e) { rateState = { windowStart: null, countUsed: 0 }; }

function saveRateState() {
    try { fs.writeFileSync(RATE_STATE_FILE, JSON.stringify(rateState, null, 2), 'utf8'); } catch (e) {}
}

const quotaEmitter = new EventEmitter();

function timeUntilResetSec() {
    if (!rateState.windowStart) return 0;
    const resetAt = rateState.windowStart + 3600 * 1000;
    return Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
}

function canMakeRequest() {
    if (!rateState.windowStart) return true;
    if (Date.now() - rateState.windowStart >= 3600 * 1000) return true;
    return rateState.countUsed < RATE_LIMIT;
}

let resetTimer = null;
function scheduleResetIfNeeded() {
    if (!rateState.windowStart) return;
    const ms = rateState.windowStart + 3600 * 1000 - Date.now();
    if (ms <= 0) return resetWindow();
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(resetWindow, ms + 50);
}

function resetWindow() {
    rateState.windowStart = null;
    rateState.countUsed = 0;
    saveRateState();
    quotaEmitter.emit('quota_reset');
    // trigger a single pass of active watches when quota resets
    try { triggerWatchesOnce(); } catch (e) {}
}

function registerSuccessfulRequest() {
    const now = Date.now();
    if (!rateState.windowStart || now - rateState.windowStart >= 3600 * 1000) {
        rateState.windowStart = now;
        rateState.countUsed = 1;
    } else {
        rateState.countUsed = (rateState.countUsed || 0) + 1;
    }
    saveRateState();
    if (rateState.countUsed >= RATE_LIMIT) scheduleResetIfNeeded();
    else scheduleResetIfNeeded();
}

function getQuotaInfo() {
    const remaining = Math.max(0, RATE_LIMIT - (rateState.countUsed || 0));
    const secs = timeUntilResetSec();
    return { limit: RATE_LIMIT, used: rateState.countUsed || 0, remaining, secsUntilReset: secs };
}

function extractArrayFromResponse(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.result)) return data.result;

    if (data && typeof data === 'object') {
        for (const key of Object.keys(data)) {
            if (Array.isArray(data[key])) return data[key];
        }
    }
    return null;
}

async function getRegions() {
    if (cachedRegions) return cachedRegions;

    // Prefer local fallback list to avoid hitting API repeatedly.
    try {
        const fallback = require('./regions_fallback.json');
        let base = fallback.map(item => ({ raw: item, name: item.name, id: item.id || null }));

        // If we have a cached API file, merge any known ids into the fallback by name.
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const raw = fs.readFileSync(CACHE_FILE, 'utf8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    const apiByName = {};
                    parsed.forEach(p => { if (p && p.name) apiByName[p.name.toString().toLowerCase()] = p; });
                    base = base.map(b => {
                        const key = b.name && b.name.toString().toLowerCase();
                        if (key && apiByName[key] && apiByName[key].id) {
                            return { raw: b.raw, name: b.name, id: apiByName[key].id };
                        }
                        return b;
                    });
                }
            }
        } catch (e) {
            // ignore merge errors
        }

        cachedRegions = base;
        return cachedRegions;
    } catch (err) {
        console.error('Не вдалося завантажити локальний fallback областей:', err && err.message ? err.message : err);
        // As last resort, try to read cache file
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const raw = fs.readFileSync(CACHE_FILE, 'utf8');
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    cachedRegions = parsed;
                    return cachedRegions;
                }
            }
        } catch (e) {}

        cachedRegions = [];
        return cachedRegions;
    }
}

function forceRefreshRegions() {
    cachedRegions = null;
    try { fs.unlinkSync(CACHE_FILE); } catch (e) {}
    return getRegions();
}

function isRateLimited() {
    if (!rateLimitedUntil) return false;
    return Date.now() < rateLimitedUntil;
}

function normalizeRegionName(s) {
    if (!s) return '';
    return s.toString().toLowerCase().replace(/\s+/g, ' ').replace(/област|область|region|regiona/g, '').trim();
}

async function getRegionIdByName(regionName) {
    if (!regionName) return null;
    const regions = await getRegions();
    const needle = normalizeRegionName(regionName);

    let found = regions.find(r => normalizeRegionName(r.name) === needle);
    if (!found) found = regions.find(r => normalizeRegionName(r.name).includes(needle));
    if (!found) found = regions.find(r => needle.includes(normalizeRegionName(r.name)));

    return found ? found.id || (found.raw && (found.raw.value || found.raw.id)) : null;
}

async function searchIds({ maxPrice = 10000, regionId = null, count = 20 } = {}) {
    // ensure quota window is reset if elapsed
    if (rateState.windowStart && Date.now() - rateState.windowStart >= 3600 * 1000) {
        rateState.windowStart = null;
        rateState.countUsed = 0;
        saveRateState();
    }

    if (!canMakeRequest()) {
        // immediate short-circuit: report rate limited
        rateLimitedUntil = Date.now() + timeUntilResetSec() * 1000;
        return [];
    }
    const apiKey = process.env.AUTORIA_API_KEY;
    const regionParam = regionId ? `&state[0]=${regionId}` : '';
    const url = `https://developers.ria.com/auto/search?api_key=${apiKey}&category_id=1${regionParam}&price_ot=0&price_do=${maxPrice}`;
    const maxRetries = 4;
    let attempt = 0;

    while (attempt < maxRetries) {
        try {
            const res = await axios.get(url);
            const ids = res.data && res.data.result && res.data.result.search_result && res.data.result.search_result.ids
                ? res.data.result.search_result.ids
                : [];
            // Count this as a successful API call
            try { registerSuccessfulRequest(); } catch (e) {}
            return ids.slice(0, count);
        } catch (err) {
            attempt++;
            const status = err && err.response && err.response.status;
            if (err && err.response) {
                try {
                    console.error('searchIds HTTP error response:', {
                        status: err.response.status,
                        headers: err.response.headers,
                        data: err.response.data
                    });
                } catch (e) { console.error('Failed to log searchIds response details', e); }
            }
            if (status === 429) {
                const ra = err.response.headers && (err.response.headers['retry-after'] || err.response.headers['Retry-After']);
                const waitSec = ra ? parseInt(ra, 10) : Math.min(2 ** attempt, 30);
                rateLimitedUntil = Date.now() + waitSec * 1000;
                console.warn(`Отримано 429 від API під час пошуку, очікуємо ${waitSec} сек (спроба ${attempt}/${maxRetries})`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
                continue;
            }
            console.error('searchIds error', err && err.message ? err.message : err);
            break;
        }
    }
    return [];
}

async function getAutoInfo(id) {
    const apiKey = process.env.AUTORIA_API_KEY;
    const url = `https://developers.ria.com/auto/info?api_key=${apiKey}&auto_id=${id}`;
    const maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            const res = await axios.get(url);
            try { registerSuccessfulRequest(); } catch (e) {}
            return res.data || null;
        } catch (err) {
            attempt++;
            const status = err && err.response && err.response.status;
            if (err && err.response) {
                try {
                    console.error('getAutoInfo HTTP error response:', {
                        id,
                        status: err.response.status,
                        headers: err.response.headers,
                        data: err.response.data
                    });
                } catch (e) { console.error('Failed to log getAutoInfo response details', e); }
            }
            if (status === 429) {
                const ra = err.response.headers && (err.response.headers['retry-after'] || err.response.headers['Retry-After']);
                const waitSec = ra ? parseInt(ra, 10) : Math.min(2 ** attempt, 20);
                rateLimitedUntil = Date.now() + waitSec * 1000;
                console.warn(`Отримано 429 від API при запиті info=${id}, очікуємо ${waitSec} сек (спроба ${attempt}/${maxRetries})`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
                continue;
            }
            console.error('getAutoInfo error', err && err.message ? err.message : err);
            break;
        }
    }
    return null;
}

async function getAveragePrice(markId, modelId, year) {
    if (!markId || !modelId || !year) return null;
    const apiKey = process.env.AUTORIA_API_KEY;
    const url = `https://developers.ria.com/auto/average_price?api_key=${apiKey}&mark_id=${markId}&model_id=${modelId}&year=${year}`;
    const maxRetries = 3;
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            const res = await axios.get(url);
            // Try to extract average price from response
            if (res && res.data) {
                // Common field names: result.average_price or result.avg or data
                const data = res.data.result || res.data;
                if (data && (data.average_price || data.avg || data.price)) {
                    return Number(data.average_price || data.avg || data.price) || null;
                }
                // Try to find any numeric field
                for (const key of Object.keys(data || {})) {
                    const v = data[key];
                    if (typeof v === 'number') return v;
                }
            }
            try { registerSuccessfulRequest(); } catch (e) {}
            return null;
        } catch (err) {
            attempt++;
            const status = err && err.response && err.response.status;
            if (err && err.response) {
                try {
                    console.error('getAveragePrice HTTP error response:', {
                        markId,
                        modelId,
                        year,
                        status: err.response.status,
                        headers: err.response.headers,
                        data: err.response.data
                    });
                } catch (e) { console.error('Failed to log getAveragePrice response details', e); }
            }
            if (status === 429) {
                const ra = err.response.headers && (err.response.headers['retry-after'] || err.response.headers['Retry-After']);
                const waitSec = ra ? parseInt(ra, 10) : Math.min(2 ** attempt, 20);
                rateLimitedUntil = Date.now() + waitSec * 1000;
                console.warn(`Отримано 429 від API при запиті average_price, очікуємо ${waitSec} сек (спроба ${attempt}/${maxRetries})`);
                await new Promise(r => setTimeout(r, waitSec * 1000));
                continue;
            }
            console.error('getAveragePrice error', err && err.message ? err.message : err);
            break;
        }
    }
    // If API failed or returned no data, try cached recent prices
    try {
        const key = `${markId}:${modelId}:${year}`;
        const arr = avgCache[key];
        if (Array.isArray(arr) && arr.length > 0) {
            const sum = arr.reduce((s, v) => s + Number(v), 0);
            const avg = Math.round(sum / arr.length);
            return avg;
        }
    } catch (e) {}
    return null;
}

function recordPrice(markId, modelId, year, price) {
    if (!markId || !modelId || !year || !price) return;
    const key = `${markId}:${modelId}:${year}`;
    if (!avgCache[key]) avgCache[key] = [];
    avgCache[key].push(Number(price));
    // keep last 50 entries
    if (avgCache[key].length > 50) avgCache[key] = avgCache[key].slice(-50);
    saveAvgCache();
}

function getCachedAverage(markId, modelId, year) {
    const key = `${markId}:${modelId}:${year}`;
    const arr = avgCache[key];
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const sum = arr.reduce((s, v) => s + Number(v), 0);
    return Math.round(sum / arr.length);
}

// Watch manager: emits 'new' events with car data when new ids appear
const watchEmitter = new EventEmitter();
const activeWatches = new Map();

function startWatch({ chatId, regionId, maxPrice = 10000, intervalSec = 300, count = 50 }) {
    const key = `${chatId}:${regionId}`;
    if (activeWatches.has(key)) return false; // already watching

    const seen = new Set();
    let stopped = false;

    const timer = setInterval(async () => {
        if (stopped) return;
        try {
            // respect quota before polling
            if (!canMakeRequest()) return;
            const ids = await searchIds({ maxPrice, regionId, count });
            const newIds = ids.filter(id => !seen.has(id));
            if (newIds.length) {
                for (const id of newIds) seen.add(id);
                for (const id of newIds) {
                    const info = await getAutoInfo(id);
                    watchEmitter.emit('new', { chatId, regionId, id, info });
                        // коротка пауза між запитами info щоб не робити бурхливих запитів
                        await new Promise(r => setTimeout(r, 800));
                }
            }
        } catch (err) {
            console.error('watch error', err && err.message ? err.message : err);
        }
    }, Math.max(300000, intervalSec * 1000));

    // Do not perform a mass fetch on start to avoid consuming quota.

    activeWatches.set(key, { timer, seen, config: { chatId, regionId, maxPrice, intervalSec, count } });
    return true;
}

function stopWatch({ chatId, regionId }) {
    const key = `${chatId}:${regionId}`;
    const w = activeWatches.get(key);
    if (!w) return false;
    clearInterval(w.timer);
    activeWatches.delete(key);
    return true;
}

function listWatches() {
    const out = [];
    for (const [k, v] of activeWatches.entries()) {
        out.push({ key: k, config: v.config });
    }
    return out;
}

// Trigger a single pass for all active watches (used when quota resets)
async function triggerWatchesOnce() {
    for (const [k, v] of activeWatches.entries()) {
        const cfg = v.config;
        try {
            if (!canMakeRequest()) break;
            const ids = await searchIds({ maxPrice: cfg.maxPrice, regionId: cfg.regionId, count: cfg.count });
            const newIds = ids.filter(id => !v.seen.has(id));
            if (newIds.length) {
                for (const id of newIds) v.seen.add(id);
                for (const id of newIds) {
                    const info = await getAutoInfo(id);
                    watchEmitter.emit('new', { chatId: cfg.chatId, regionId: cfg.regionId, id, info });
                    await new Promise(r => setTimeout(r, 800));
                }
            }
        } catch (e) {
            console.error('triggerWatchesOnce error', e && e.message ? e.message : e);
        }
    }
}

module.exports = {
    getRegions,
    getRegionIdByName,
    searchIds,
    getAutoInfo,
    getAveragePrice,
    recordPrice,
    getCachedAverage,
    startWatch,
    stopWatch,
    watchEmitter,
    listWatches
};

module.exports.isRateLimited = isRateLimited;
module.exports.forceRefreshRegions = forceRefreshRegions;
module.exports.quotaEmitter = quotaEmitter;
module.exports.getQuotaInfo = getQuotaInfo;
module.exports.canMakeRequest = canMakeRequest;
module.exports.registerSuccessfulRequest = registerSuccessfulRequest;
module.exports.triggerWatchesOnce = triggerWatchesOnce;