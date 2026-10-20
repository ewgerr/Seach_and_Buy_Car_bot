function mainKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['🔎 Новий пошук', '⚙️ Налаштування'],
                ['⏱ Увімкнути спостереження', '⏹ Вимкнути спостереження'],
                ['🟠 OLX пошук', '🟠 OLX спостереження'],
                ['🟠 OLX стоп'],
                ['ℹ️ Допомога']
            ],
            resize_keyboard: true
        }
    };
}

function settingsKeyboard() {
    return {
        reply_markup: {
            keyboard: [
                ['Встановити кількість авто', 'Назад']
            ],
            resize_keyboard: true
        }
    };
}

module.exports = { mainKeyboard, settingsKeyboard };

// Побудова inline-клавіатури для вибору областей з пагінацією
function buildRegionKeyboard(regions, page = 0, purpose = 'search', pageSize = 9) {
    const start = page * pageSize;
    const slice = regions.slice(start, start + pageSize);

    const buttons = slice.map((r, i) => {
        // callback_data carries the global index (start + i) to keep payload small
        const idx = start + i;
        return [{ text: r.name, callback_data: `region|${purpose}|${idx}` }];
    });

    const nav = [];
    if (page > 0) nav.push({ text: '⬅️ Назад', callback_data: `region_page|${purpose}|${page - 1}` });
    if (start + pageSize < regions.length) nav.push({ text: '➡️ Далі', callback_data: `region_page|${purpose}|${page + 1}` });
    if (nav.length) buttons.push(nav);

    buttons.push([{ text: '❌ Скасувати', callback_data: `region_cancel|${purpose}` }]);

    return { reply_markup: { inline_keyboard: buttons } };
}

module.exports.buildRegionKeyboard = buildRegionKeyboard;
