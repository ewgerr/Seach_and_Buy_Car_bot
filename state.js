const fs = require('fs');
const path = require('path');

const STORE_FILE = path.join(__dirname, 'state.json');

let store = {
    users: {}
};

function load() {
    try {
        if (fs.existsSync(STORE_FILE)) {
            const raw = fs.readFileSync(STORE_FILE, 'utf8');
            store = JSON.parse(raw);
        }
    } catch (err) {
        console.error('Failed to load state:', err && err.message ? err.message : err);
    }
}

function save() {
    try {
        fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save state:', err && err.message ? err.message : err);
    }
}

function getUser(chatId) {
    if (!store.users[chatId]) {
        store.users[chatId] = { step: null, data: {}, settings: { defaultCount: 10, notifyOnQuotaReset: false, watchInterval: 300 } };
        save();
    }
    return store.users[chatId];
}

function setUser(chatId, user) {
    store.users[chatId] = user;
    save();
}

function clearUser(chatId) {
    delete store.users[chatId];
    save();
}

function listUsers() {
    try { return Object.keys(store.users).map(k => Number(k)); } catch (e) { return []; }
}

load();

module.exports = { getUser, setUser, clearUser, save, listUsers };
