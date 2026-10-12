require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const {
    getRegionIdByName,
    searchIds,
    getAutoInfo,
    getAveragePrice,
    recordPrice,
    getCachedAverage,
    startWatch,
    stopWatch,
    watchEmitter,
    isRateLimited
} = require('./autoria_region_api');
const fs = require('fs');
const path = require('path');

const state = require('./state');
const menu = require('./menu');
const {
    quotaEmitter,
    getQuotaInfo,
    canMakeRequest
} = require('./autoria_region_api');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
    console.error('Missing TELEGRAM_TOKEN in environment');
    process.exit(1);
}

console.log('Starting bot...');
console.log('Node version:', process.version);
console.log('Working dir:', __dirname);
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const delay = (ms) => new Promise(r => setTimeout(r, ms));

// Global error handlers to avoid process exit on unexpected errors
process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled Rejection at:', p, 'reason:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});

// Ensure a single global listener that relays watch events to chats
let exampleInfoLogged = false;
watchEmitter.on('new', async ({ chatId, id, info }) => {
    try {
        if (!info) return;
        const make = info.markName || '';
        const model = info.modelName || '';
        const year = (info.autoData && info.autoData.year) || '';
        const priceVal = (info.USD && Number(info.USD)) || (info.price && Number(info.price)) || null;
        const link = info.linkToView ? `https://auto.ria.com${info.linkToView}` : 'https://auto.ria.com';
        let evalText = '';
        if (priceVal) {
            const avg = await getAveragePrice(info.markId, info.modelId, year) || getCachedAverage(info.markId, info.modelId, year);
            const pe = evaluatePrice(priceVal, avg);
            evalText = `\n📊 Оцінка ціни: ${pe}${avg ? ` (середн. $${avg})` : ''}`;
        }
        const message = `🚗 ${make} ${model} (${year})\n💵 ${priceVal ? '$' + priceVal : 'N/A'}${evalText}\n🔗 ${link}`;
        await bot.sendMessage(chatId, message);
        try { if (priceVal && info.markId && info.modelId) recordPrice(info.markId, info.modelId, year, priceVal); } catch (e) {}
        try {
            if (!exampleInfoLogged) {
                fs.writeFileSync(path.join(__dirname, 'example_info.json'), JSON.stringify(info, null, 2), 'utf8');
                console.log('Записано приклад info -> example_info.json');
                exampleInfoLogged = true;
            }
        } catch (e) {}
    } catch (err) {
        console.error('Failed to forward watch event:', err && err.message ? err.message : err);
    }
});

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const user = state.getUser(chatId);
    user.step = null;
    state.setUser(chatId, user);
    bot.sendMessage(chatId, 'Вітаю! Меню бота:', menu.mainKeyboard());
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text) return;

    const user = state.getUser(chatId);

    // Menu options
    if (text === '🔎 Новий пошук') {
        user.step = 'awaiting_price';
        state.setUser(chatId, user);
        return bot.sendMessage(chatId, 'Введіть максимальну ціну в $ (наприклад: 5000):');
    }

    if (text === '⚙️ Налаштування') {
        return bot.sendMessage(chatId, 'Налаштування:', menu.settingsKeyboard());
    }

    if (text === 'Встановити кількість авто') {
        user.step = 'awaiting_count';
        state.setUser(chatId, user);
        return bot.sendMessage(chatId, 'Введіть кількість авто для пошуку (наприклад: 10):');
    }

    if (text === '⏱ Увімкнути спостереження') {
        user.step = 'awaiting_watch_region';
        state.setUser(chatId, user);
        return bot.sendMessage(chatId, 'Введіть назву області для спостереження (наприклад: Київська):');
    }

    if (text === '⏹ Вимкнути спостереження') {
        user.step = 'awaiting_stop_region';
        state.setUser(chatId, user);
        return bot.sendMessage(chatId, 'Введіть назву області, для якої бажаєте зупинити спостереження:');
    }

    if (text === 'Назад') {
        user.step = null;
        state.setUser(chatId, user);
        return bot.sendMessage(chatId, 'Повернувся в головне меню', menu.mainKeyboard());
    }

    if (text === 'ℹ️ Допомога') {
        return bot.sendMessage(chatId, 'Використовуйте меню для керування ботом. Новий пошук — задати ціну та область. Увімкнути спостереження — отримувати нові оголошення у вибраній області.');
    }

    // Flow: awaiting_count
    if (user.step === 'awaiting_count') {
        const n = parseInt(text);
        if (isNaN(n) || n <= 0) return bot.sendMessage(chatId, 'Будь ласка, введіть позитивне числове значення.');
        user.settings.defaultCount = Math.min(100, n);
        user.step = null;
        state.setUser(chatId, user);
        return bot.sendMessage(chatId, `Кількість авто встановлено: ${user.settings.defaultCount}`, menu.mainKeyboard());
    }

    // Flow: new search awaiting_price
    if (user.step === 'awaiting_price') {
        const price = parseInt(text);
        if (isNaN(price) || price <= 0) return bot.sendMessage(chatId, 'Будь ласка, введіть числову ціну > 0.');
        user.data.maxPrice = price;
        user.step = 'awaiting_region_selection';
        state.setUser(chatId, user);
        // Покажемо меню вибору області
        return sendRegionSelection(chatId, 'search', 0);
    }

    // Якщо користувач ввів ціну після того, як вибрав область (через callback)
    if (user.step === 'awaiting_price_for_selected_region') {
        const price = parseInt(text);
        if (isNaN(price) || price <= 0) return bot.sendMessage(chatId, 'Будь ласка, введіть числову ціну > 0.');
        user.data.maxPrice = price;
        const regionId = user.data.pendingRegionForSearch;
        delete user.data.pendingRegionForSearch;
        user.step = null;
        state.setUser(chatId, user);

        const ids = await searchIds({ maxPrice: price, regionId, count: user.settings.defaultCount });
        if (!ids || ids.length === 0) return bot.sendMessage(chatId, 'За цими критеріями авто не знайдено.');
        for (const id of ids) {
            const info = await getAutoInfo(id);
            if (!info) continue;
            const make = info.markName || '';
            const model = info.modelName || '';
            const year = (info.autoData && info.autoData.year) || '';
            const priceVal = info.USD || info.price || 'N/A';
            const link = info.linkToView ? `https://auto.ria.com${info.linkToView}` : 'https://auto.ria.com';
            const message = `🚗 ${make} ${model} (${year})\n💵 $${priceVal}\n🔗 ${link}`;
            await bot.sendMessage(chatId, message);
            await delay(500);
        }
        return bot.sendMessage(chatId, 'Пошук завершено.', menu.mainKeyboard());
    }

    if (user.step === 'awaiting_region') {
        const regionName = text;
        bot.sendMessage(chatId, `Шукаю ID області для: ${regionName}...`);
        const regionId = await getRegionIdByName(regionName);
        if (!regionId) {
            await bot.sendMessage(chatId, `Не знайдено ID для області: ${regionName}. Спробую пошук без фільтра і відфільтрую результати за назвою...`);
            if (isRateLimited()) return bot.sendMessage(chatId, 'API тимчасово перевантажено або обмежено (429). Спробуйте пізніше.');
            const ids = await searchIds({ maxPrice: user.data.maxPrice || 10000, regionId: null, count: Math.max(50, user.settings.defaultCount) });
            if (!ids || ids.length === 0) return bot.sendMessage(chatId, 'За цими критеріями авто не знайдено.');
            let sent = 0;
            for (const id of ids) {
                const info = await getAutoInfo(id);
                if (!info) continue;
                if (!matchesRegionInfo(info, regionName)) continue;
                const make = info.markName || '';
                const model = info.modelName || '';
                const year = (info.autoData && info.autoData.year) || '';
                const price = info.USD || info.price || 'N/A';
                const link = info.linkToView ? `https://auto.ria.com${info.linkToView}` : 'https://auto.ria.com';
                const message = `🚗 ${make} ${model} (${year})\n💵 $${price}\n🔗 ${link}`;
                await bot.sendMessage(chatId, message);
                await delay(500);
                sent++;
                if (sent >= user.settings.defaultCount) break;
            }
            if (sent === 0) return bot.sendMessage(chatId, 'За цими критеріями авто не знайдено.');
            user.step = null;
            state.setUser(chatId, user);
            return bot.sendMessage(chatId, 'Пошук завершено.', menu.mainKeyboard());
        }

        bot.sendMessage(chatId, `Область знайдена (ID: ${regionId}). Шукаю...`);
        if (isRateLimited()) return bot.sendMessage(chatId, 'API тимчасово перевантажено або обмежено (429). Спробуйте пізніше.');
        const ids = await searchIds({ maxPrice: user.data.maxPrice || 10000, regionId, count: user.settings.defaultCount });
        if (!ids || ids.length === 0) return bot.sendMessage(chatId, 'За цими критеріями авто не знайдено.');

        for (const id of ids) {
            const info = await getAutoInfo(id);
            if (!info) continue;
            const make = info.markName || '';
            const model = info.modelName || '';
            const year = (info.autoData && info.autoData.year) || '';
            const priceVal = (info.USD && Number(info.USD)) || (info.price && Number(info.price)) || null;
            const link = info.linkToView ? `https://auto.ria.com${info.linkToView}` : 'https://auto.ria.com';
            let evalText = '';
            if (priceVal) {
                const avg = await getAveragePrice(info.markId, info.modelId, year);
                const pe = evaluatePrice(priceVal, avg);
                evalText = `\n📊 Оцінка ціни: ${pe}${avg ? ` (середн. $${avg})` : ''}`;
            }
            const message = `🚗 ${make} ${model} (${year})\n💵 ${priceVal ? '$' + priceVal : 'N/A'}${evalText}\n🔗 ${link}`;
            await bot.sendMessage(chatId, message);
            await delay(500);
        }

        user.step = null;
        state.setUser(chatId, user);
        return bot.sendMessage(chatId, 'Пошук завершено.', menu.mainKeyboard());
    }

    // Flow: start watch - awaiting region
    if (user.step === 'awaiting_watch_region') {
        // Backwards compatible: if user typed a name, resolve it
        const regionName = text;
        bot.sendMessage(chatId, `Шукаю ID області для: ${regionName}...`);
        const regionId = await getRegionIdByName(regionName);
        if (!regionId) return bot.sendMessage(chatId, `Не знайдено область: ${regionName}`);

        user.data.watchRegionId = regionId;
        user.step = 'awaiting_watch_price';
        state.setUser(chatId, user);
        return bot.sendMessage(chatId, 'Введіть максимальну ціну для спостереження (наприклад: 5000):');
    }

    if (user.step === 'awaiting_watch_price') {
        const price = parseInt(text);
        if (isNaN(price) || price <= 0) return bot.sendMessage(chatId, 'Будь ласка, введіть числову ціну > 0.');
        const regionId = user.data.watchRegionId;
        const count = user.settings.defaultCount || 20;
        const interval = (user.settings && user.settings.watchInterval) || 300;
        const started = startWatch({ chatId, regionId, maxPrice: price, intervalSec: interval, count });
        user.step = null;
        state.setUser(chatId, user);
        if (started) return bot.sendMessage(chatId, 'Спостереження увімкнено. Ви будете отримувати нові оголошення для вибраної області.');
        return bot.sendMessage(chatId, 'Спостереження вже запущено для цієї області.');
    }

    // Flow: stop watch
    if (user.step === 'awaiting_stop_region') {
        const regionName = text;
        const regionId = await getRegionIdByName(regionName);
        if (!regionId) return bot.sendMessage(chatId, `Не знайдено область: ${regionName}`);
        const stopped = stopWatch({ chatId, regionId });
        user.step = null;
        state.setUser(chatId, user);
        if (stopped) return bot.sendMessage(chatId, 'Спостереження зупинено.', menu.mainKeyboard());
        return bot.sendMessage(chatId, 'Спостереження для цієї області не знайдено.');
    }

    // Якщо нічого з вище — по замовчуванню покажемо меню
    return bot.sendMessage(chatId, 'Оберіть опцію з меню:', menu.mainKeyboard());
});

// Відправити меню вибору області (пагінований)
async function sendRegionSelection(chatId, purpose = 'search', page = 0) {
    try {
        const regions = await require('./autoria_region_api').getRegions();
        if (!regions || regions.length === 0) return bot.sendMessage(chatId, 'Не вдалося завантажити список областей. Спробуйте пізніше.');
        const kb = menu.buildRegionKeyboard(regions, page, purpose);
        return bot.sendMessage(chatId, 'Оберіть область:', kb);
    } catch (err) {
        console.error('sendRegionSelection error', err && err.message ? err.message : err);
        return bot.sendMessage(chatId, 'Помилка при підготовці меню областей.');
    }
}

function normalizeForCompare(s) {
    if (!s) return '';
    return s.toString().toLowerCase().replace(/\s+/g, ' ').replace(/[^a-zа-я0-9\s\-]/gi, '').trim();
}

function matchesRegionInfo(info, regionName) {
    if (!info) return false;
    const needle = normalizeForCompare(regionName);
    const candidates = [];
    if (info.stateName) candidates.push(info.stateName);
    if (info.location && info.location.regionName) candidates.push(info.location.regionName);
    if (info.location && info.location.stateName) candidates.push(info.location.stateName);
    if (info.cityName) candidates.push(info.cityName);
    if (info.addressRegion) candidates.push(info.addressRegion);
    if (info.region) candidates.push(info.region);
    // join and test
    for (const c of candidates) {
        if (!c) continue;
        if (normalizeForCompare(c).includes(needle)) return true;
    }
    return false;
}

// Оцінка ціни
function evaluatePrice(actualPrice, avgPrice) {
    if (!avgPrice || !actualPrice) return '⚪ Немає даних для оцінки';
    const ratio = Number(actualPrice) / Number(avgPrice);
    if (isNaN(ratio)) return '⚪ Немає даних для оцінки';
    if (ratio > 1.2) return '🔴 Дуже завищена (на 20%+ вище ринку)';
    if (ratio > 1.05) return '🟡 Трохи вище ринку';
    if (ratio < 0.85) return '🟢 Нижче ринку (можливі приховані дефекти)';
    return '⚪ Нормальна ринкова ціна';
}

// Обробка callback'ів з inline-кнопок (вибір області, навігація)
bot.on('callback_query', async (cb) => {
    try {
        const data = cb.data || '';
        const chatId = cb.message && cb.message.chat && cb.message.chat.id;
        // Ignore stale callback queries (e.g., delivered from Telegram on bot restart)
        try {
            const msgDate = cb.message && cb.message.date; // unix seconds
            if (msgDate) {
                const ageSec = Math.floor(Date.now() / 1000) - msgDate;
                if (ageSec > 300) { // ignore older than 5 minutes
                    try { await bot.answerCallbackQuery(cb.id, { text: 'Ця дія застаріла.' }); } catch (e) {}
                    return;
                }
            }
        } catch (e) {}
        if (!data || !chatId) return bot.answerCallbackQuery(cb.id || cb.id, { text: 'Невірні дані' });

        const parts = data.split('|');
        if (parts[0] === 'region_page') {
            const purpose = parts[1] || 'search';
            const page = parseInt(parts[2]) || 0;
            const regions = await require('./autoria_region_api').getRegions();
            const kb = menu.buildRegionKeyboard(regions, page, purpose);
            await bot.editMessageReplyMarkup(kb.reply_markup, { chat_id: chatId, message_id: cb.message.message_id });
            return bot.answerCallbackQuery(cb.id, { text: '' });
        }

        if (parts[0] === 'region_cancel') {
            await bot.editMessageText('Вибір області скасовано.', { chat_id: chatId, message_id: cb.message.message_id });
            return bot.answerCallbackQuery(cb.id, { text: 'Скасовано' });
        }

        if (parts[0] === 'region') {
            const purpose = parts[1] || 'search';
            const idx = parseInt(parts[2], 10);
            const regions = await require('./autoria_region_api').getRegions();
            if (isNaN(idx) || idx < 0 || !Array.isArray(regions) || idx >= regions.length) {
                await bot.answerCallbackQuery(cb.id, { text: 'Невірний вибір області' });
                return;
            }
            await bot.answerCallbackQuery(cb.id, { text: 'Область вибрана' });

            if (isRateLimited()) {
                return bot.sendMessage(chatId, 'API тимчасово перевантажено або обмежено (429). Спробуйте пізніше.');
            }
            const region = Array.isArray(regions) && regions[idx] ? regions[idx] : null;
            const regionId = region && region.id ? region.id : null;
            const regionName = region ? region.name : 'невідома';

            const user = state.getUser(chatId);
            if (purpose === 'search') {
                // Якщо у вибраної області відсутній ID (локальний fallback), зробимо пошук без state і відфільтруємо по назві
                if (!regionId) {
                    await bot.sendMessage(chatId, `Ви обрали область: ${regionName}. Роблю пошук без ID та фільтрую результати за назвою області...`);
                    if (isRateLimited()) return bot.sendMessage(chatId, 'API тимчасово перевантажено або обмежено (429). Спробуйте пізніше.');
                    const ids = await searchIds({ maxPrice: user.data.maxPrice || 10000, regionId: null, count: Math.max(50, user.settings.defaultCount) });
                    if (!ids || ids.length === 0) return bot.sendMessage(chatId, 'За цими критеріями авто не знайдено.');
                    let sent = 0;
                    for (const id of ids) {
                        const info = await getAutoInfo(id);
                        if (!info) continue;
                        if (!matchesRegionInfo(info, regionName)) continue;
                        const make = info.markName || '';
                        const model = info.modelName || '';
                        const year = (info.autoData && info.autoData.year) || '';
                        const price = info.USD || info.price || 'N/A';
                        const link = info.linkToView ? `https://auto.ria.com${info.linkToView}` : 'https://auto.ria.com';
                        const message = `🚗 ${make} ${model} (${year})\n💵 $${price}\n🔗 ${link}`;
                        await bot.sendMessage(chatId, message);
                        await delay(500);
                        sent++;
                        if (sent >= user.settings.defaultCount) break;
                    }
                    if (sent === 0) await bot.sendMessage(chatId, 'За цими критеріями авто не знайдено.');
                    user.step = null;
                    state.setUser(chatId, user);
                    return;
                }

                // Якщо не задана ціна — попросимо її
                if (!user.data.maxPrice) {
                    user.data.pendingRegionForSearch = regionId;
                    user.step = 'awaiting_price_for_selected_region';
                    state.setUser(chatId, user);
                    await bot.sendMessage(chatId, 'Введіть максимальну ціну для пошуку (наприклад: 5000):');
                    return;
                }

                // Виконуємо пошук з regionId
                if (isRateLimited()) return bot.sendMessage(chatId, 'API тимчасово перевантажено або обмежено (429). Спробуйте пізніше.');
                const ids = await searchIds({ maxPrice: user.data.maxPrice || 10000, regionId, count: user.settings.defaultCount });
                if (!ids || ids.length === 0) {
                    await bot.sendMessage(chatId, 'За цими критеріями авто не знайдено.');
                    return;
                }
                for (const id of ids) {
                    const info = await getAutoInfo(id);
                    if (!info) continue;
                    const make = info.markName || '';
                    const model = info.modelName || '';
                    const year = (info.autoData && info.autoData.year) || '';
                    const priceVal = (info.USD && Number(info.USD)) || (info.price && Number(info.price)) || null;
                    const link = info.linkToView ? `https://auto.ria.com${info.linkToView}` : 'https://auto.ria.com';
                    let evalText = '';
                    if (priceVal) {
                        const avg = await getAveragePrice(info.markId, info.modelId, year);
                        const pe = evaluatePrice(priceVal, avg);
                        evalText = `\n📊 Оцінка ціни: ${pe}${avg ? ` (середн. $${avg})` : ''}`;
                    }
                    const message = `🚗 ${make} ${model} (${year})\n💵 ${priceVal ? '$' + priceVal : 'N/A'}${evalText}\n🔗 ${link}`;
                    await bot.sendMessage(chatId, message);
                    await delay(500);
                }
                user.step = null;
                state.setUser(chatId, user);
                return;
            }

            if (purpose === 'watch') {
                // Збережемо регіон і попросимо ціну для спостереження
                user.data.watchRegionId = regionId;
                user.step = 'awaiting_watch_price';
                state.setUser(chatId, user);
                await bot.sendMessage(chatId, 'Вибрано область для спостереження. Тепер введіть максимальну ціну для фільтра (наприклад: 5000):');
                return;
            }

            if (purpose === 'stop') {
                const stopped = stopWatch({ chatId, regionId });
                await bot.sendMessage(chatId, stopped ? 'Спостереження зупинено.' : 'Спостереження для цієї області не знайдено.');
                return;
            }

        }

        return bot.answerCallbackQuery(cb.id, { text: 'Невідома дія' });
    } catch (err) {
        console.error('callback_query handler error', err && err.message ? err.message : err);
        try { bot.answerCallbackQuery(cb.id, { text: 'Помилка' }); } catch (e) {}
    }
});

bot.onText(/\/refresh_regions/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        await require('./autoria_region_api').forceRefreshRegions();
        return bot.sendMessage(chatId, 'Спроба оновлення списку областей виконана. Спробуйте знову вибрати область.');
    } catch (err) {
        console.error('refresh_regions error', err && err.message ? err.message : err);
        return bot.sendMessage(chatId, 'Помилка при оновленні списку областей.');
    }
});

// Handle polling errors (e.g., 409 when another getUpdates is active)
bot.on('polling_error', (err) => {
    console.warn('polling_error', err && err.code ? `${err.code} ${err.message}` : err && err.message ? err.message : err);
});

// Quota status command
bot.onText(/\/quota/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const q = getQuotaInfo();
        const text = `API quota: ${q.used}/${q.limit} used. Remaining: ${q.remaining}. Reset in ${q.secsUntilReset} sec.`;
        return bot.sendMessage(chatId, text);
    } catch (e) {
        return bot.sendMessage(chatId, 'Не вдалося отримати статус квоти.');
    }
});

// Notify users when quota resets
try {
    quotaEmitter.on('quota_reset', async () => {
        try {
            const users = state.listUsers();
            for (const uid of users) {
                try {
                    const u = state.getUser(uid);
                    if (u && u.settings && u.settings.notifyOnQuotaReset) {
                        await bot.sendMessage(uid, 'API-ліміт скинувся. Тепер можна виконувати нові пошуки.');
                    }
                } catch (e) {}
            }
        } catch (e) {}
    });
} catch (e) {}

// Commands to opt-in/out quota notifications
bot.onText(/\/notify_on/, async (msg) => {
    const chatId = msg.chat.id;
    const user = state.getUser(chatId);
    user.settings.notifyOnQuotaReset = true;
    state.setUser(chatId, user);
    return bot.sendMessage(chatId, 'Ви підписані на повідомлення про скидання квоти.');
});

bot.onText(/\/notify_off/, async (msg) => {
    const chatId = msg.chat.id;
    const user = state.getUser(chatId);
    user.settings.notifyOnQuotaReset = false;
    state.setUser(chatId, user);
    return bot.sendMessage(chatId, 'Ви відписані від повідомлень про скидання квоти.');
});

bot.onText(/\/set_interval (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const n = parseInt(match[1], 10);
    if (isNaN(n) || n < 60 || n > 3600) return bot.sendMessage(chatId, 'Інтервал має бути числом в секундах від 60 до 3600.');
    const user = state.getUser(chatId);
    user.settings.watchInterval = n;
    state.setUser(chatId, user);
    return bot.sendMessage(chatId, `Інтервал спостереження встановлено: ${n} сек.`);
});