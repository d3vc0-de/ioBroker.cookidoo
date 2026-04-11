'use strict';

const utils = require('@iobroker/adapter-core');
const https = require('node:https');
const querystring = require('node:querystring');

// ---------------------------------------------------------------------------
// Cookidoo API Konstanten (aus dem offiziellen Python-Paket miaucl/cookidoo-api)
// ---------------------------------------------------------------------------
const COOKIDOO_AUTH_HEADER = 'Basic a3VwZmVyd2Vyay1jbGllbnQtbndvdDpMczUwT04xd295U3FzMWRDZEpnZQ==';
const COOKIDOO_USER_AGENT = 'Thermomix/5427 (iPhone; iOS11.2; Scale/3.00)';
const COOKIDOO_COOKIE = 'vrkPreAccessGranted=true';
const API_BASE = (cc) => `https://${cc}.tmmobile.vorwerk-digital.com`;

/** Sprachcode → { country_code, language } */
const LOCALIZATIONS = {
    'de-DE': { country_code: 'de', language: 'de-DE' },
    'de-AT': { country_code: 'at', language: 'de-AT' },
    'de-CH': { country_code: 'ch', language: 'de-CH' },
    'de-BE': { country_code: 'be', language: 'de-BE' },
    'en-GB': { country_code: 'gb', language: 'en-GB' },
    'en-AU': { country_code: 'au', language: 'en-AU' },
    'fr-FR': { country_code: 'fr', language: 'fr-FR' },
    'fr-BE': { country_code: 'be', language: 'fr-BE' },
    'it-IT': { country_code: 'it', language: 'it-IT' },
    'es-ES': { country_code: 'es', language: 'es-ES' },
    'nl-NL': { country_code: 'nl', language: 'nl-NL' },
    'pt-PT': { country_code: 'pt', language: 'pt-PT' },
    'ja-JP': { country_code: 'jp', language: 'ja-JP' },
    'zh-CN': { country_code: 'cn', language: 'zh-CN' },
};

// ---------------------------------------------------------------------------

class CookidooAdapter extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    constructor(options) {
        super({ ...options, name: 'cookidoo' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.pollTimer = null;
        /** @type {{ access_token: string, refresh_token: string, token_type: string, expires_in: number } | null} */
        this.authData = null;
        /** @type {{ country_code: string, language: string } | null} */
        this.loc = null;
    }

    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------

    async onReady() {
        if (!this.config.email || !this.config.password) {
            this.log.error('E-Mail und Passwort müssen in den Adapter-Einstellungen konfiguriert sein.');
            return;
        }

        this.loc = LOCALIZATIONS[this.config.language] ?? LOCALIZATIONS['de-DE'];
        this.log.info(`Cookidoo Adapter gestartet (${this.config.language}, Abfrageintervall: ${this.config.pollInterval}s)`);

        await this.createObjects();
        this.subscribeStates('actions.*');

        try {
            await this.login();
            await this.poll();
        } catch (e) {
            this.logConnError(`Erster Login/Poll fehlgeschlagen: ${e.message}`);
            await this.setState('info.connection', { val: false, ack: true });
        }

        const intervalMs = Math.max(60, this.config.pollInterval || 300) * 1000;
        this.pollTimer = this.setInterval(() => this.safePoll(), intervalMs);
    }

    onUnload(callback) {
        try {
            if (this.pollTimer) {
                this.clearInterval(this.pollTimer);
                this.pollTimer = null;
            }
            callback();
        } catch {
            callback();
        }
    }

    /**
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    async onStateChange(id, state) {
        if (!state || state.ack) return;

        const localId = id.replace(`${this.namespace}.`, '');

        if (localId === 'actions.refresh') {
            this.log.info('Manuelle Aktualisierung ausgelöst.');
            await this.safePoll();
            await this.setState('actions.refresh', { val: false, ack: true });
        } else if (localId === 'actions.clearShoppingList') {
            this.log.info('Einkaufsliste wird geleert...');
            await this.clearShoppingList();
            await this.setState('actions.clearShoppingList', { val: false, ack: true });
        } else if (localId === 'actions.markAllOwned') {
            this.log.info('Alle Zutaten als vorhanden markieren...');
            await this.markAllIngredientsOwned(true);
            await this.setState('actions.markAllOwned', { val: false, ack: true });
        } else if (localId === 'actions.markAllUnowned') {
            this.log.info('Alle Zutaten als nicht vorhanden markieren...');
            await this.markAllIngredientsOwned(false);
            await this.setState('actions.markAllUnowned', { val: false, ack: true });
        }
    }

    // -------------------------------------------------------------------------
    // ioBroker Objekte anlegen
    // -------------------------------------------------------------------------

    async createObjects() {
        // --- info ---
        await this.setObjectNotExistsAsync('info', {
            type: 'channel', common: { name: 'Informationen' }, native: {},
        });
        await this.setObjectNotExistsAsync('info.connection', {
            type: 'state',
            common: { name: 'Verbindung', type: 'boolean', role: 'indicator.connected', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.username', {
            type: 'state',
            common: { name: 'Benutzername', type: 'string', role: 'info.name', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.subscriptionActive', {
            type: 'state',
            common: { name: 'Abo aktiv', type: 'boolean', role: 'indicator', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.subscriptionExpires', {
            type: 'state',
            common: { name: 'Abo läuft ab', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.subscriptionStatus', {
            type: 'state',
            common: { name: 'Abo-Status', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('info.subscriptionLevel', {
            type: 'state',
            common: { name: 'Abo-Stufe', type: 'string', role: 'text', read: true, write: false },
            native: {},
        });

        // --- shopping ---
        await this.setObjectNotExistsAsync('shopping', {
            type: 'channel', common: { name: 'Einkaufsliste' }, native: {},
        });
        await this.setObjectNotExistsAsync('shopping.recipes', {
            type: 'state',
            common: { name: 'Rezepte auf der Einkaufsliste (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('shopping.recipesCount', {
            type: 'state',
            common: { name: 'Anzahl Rezepte', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('shopping.ingredientItems', {
            type: 'state',
            common: { name: 'Zutaten (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('shopping.ingredientItemsCount', {
            type: 'state',
            common: { name: 'Anzahl Zutaten', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('shopping.unownedIngredientsCount', {
            type: 'state',
            common: { name: 'Fehlende Zutaten', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('shopping.additionalItems', {
            type: 'state',
            common: { name: 'Zusätzliche Artikel (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('shopping.additionalItemsCount', {
            type: 'state',
            common: { name: 'Anzahl zusätzliche Artikel', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('shopping.unownedAdditionalCount', {
            type: 'state',
            common: { name: 'Fehlende zusätzliche Artikel', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });

        // --- calendar ---
        await this.setObjectNotExistsAsync('calendar', {
            type: 'channel', common: { name: 'Wochenkalender' }, native: {},
        });
        await this.setObjectNotExistsAsync('calendar.week', {
            type: 'state',
            common: { name: 'Aktuelle Woche (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('calendar.todayRecipes', {
            type: 'state',
            common: { name: 'Rezepte heute (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });

        // --- collections ---
        await this.setObjectNotExistsAsync('collections', {
            type: 'channel', common: { name: 'Kollektionen' }, native: {},
        });
        await this.setObjectNotExistsAsync('collections.managed', {
            type: 'state',
            common: { name: 'Vorwerk-Kollektionen (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('collections.managedCount', {
            type: 'state',
            common: { name: 'Anzahl Vorwerk-Kollektionen', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('collections.custom', {
            type: 'state',
            common: { name: 'Eigene Kollektionen (JSON)', type: 'string', role: 'json', read: true, write: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('collections.customCount', {
            type: 'state',
            common: { name: 'Anzahl eigene Kollektionen', type: 'number', role: 'value', read: true, write: false },
            native: {},
        });

        // --- actions ---
        await this.setObjectNotExistsAsync('actions', {
            type: 'channel', common: { name: 'Aktionen' }, native: {},
        });
        await this.setObjectNotExistsAsync('actions.refresh', {
            type: 'state',
            common: { name: 'Daten aktualisieren', type: 'boolean', role: 'button', read: false, write: true, def: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('actions.clearShoppingList', {
            type: 'state',
            common: { name: 'Einkaufsliste leeren', type: 'boolean', role: 'button', read: false, write: true, def: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('actions.markAllOwned', {
            type: 'state',
            common: { name: 'Alle Zutaten als vorhanden markieren', type: 'boolean', role: 'button', read: false, write: true, def: false },
            native: {},
        });
        await this.setObjectNotExistsAsync('actions.markAllUnowned', {
            type: 'state',
            common: { name: 'Alle Zutaten als fehlend markieren', type: 'boolean', role: 'button', read: false, write: true, def: false },
            native: {},
        });
    }

    // -------------------------------------------------------------------------
    // Poll
    // -------------------------------------------------------------------------

    async safePoll() {
        try {
            // Token ggf. erneuern
            if (this.authData && this.tokenExpiresAt && Date.now() > this.tokenExpiresAt - 60000) {
                await this.refreshToken();
            }
            await this.poll();
        } catch (e) {
            this.logConnError(`Poll fehlgeschlagen: ${e.message}`);
            await this.setState('info.connection', { val: false, ack: true });
        }
    }

    async poll() {
        await Promise.all([
            this.fetchUserInfo(),
            this.fetchSubscription(),
            this.fetchShoppingList(),
            this.fetchCalendar(),
            this.fetchCollections(),
        ]);
        await this.setState('info.connection', { val: true, ack: true });
    }

    // -------------------------------------------------------------------------
    // Authentifizierung
    // -------------------------------------------------------------------------

    async login() {
        // Laut Raw-API-Mitschnitt: kein client_id im Login-Body, nur username/password/grant_type
        const body = querystring.stringify({
            grant_type: 'password',
            username: this.config.email,
            password: this.config.password,
        });
        await this._requestToken(body);
        this.log.info('Cookidoo Login erfolgreich.');
    }

    async refreshToken() {
        if (!this.authData) throw new Error('Kein Auth-Token vorhanden – bitte neu einloggen.');
        const body = querystring.stringify({
            grant_type: 'refresh_token',
            refresh_token: this.authData.refresh_token,
            client_id: 'kupferwerk-client-nwot',
        });
        await this._requestToken(body);
        this.log.debug('Token erneuert.');
    }

    async _requestToken(body) {
        const cc = this.loc.country_code;
        const json = await this.httpsRequest({
            hostname: `${cc}.tmmobile.vorwerk-digital.com`,
            path: '/ciam/auth/token',
            method: 'POST',
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': COOKIDOO_AUTH_HEADER,
                'User-Agent': COOKIDOO_USER_AGENT,
                'Cookie': COOKIDOO_COOKIE,
                'Accept-Language': `${this.loc.language};q=1, en;q=0.9`,
                'Accept-Encoding': 'gzip',
                'Content-Length': Buffer.byteLength(body),
            },
        }, body);

        this.authData = json;
        this.tokenExpiresAt = Date.now() + (json.expires_in * 1000);
    }

    // -------------------------------------------------------------------------
    // API-Aufrufe
    // -------------------------------------------------------------------------

    async fetchUserInfo() {
        try {
            const json = await this.apiGet('/community/profile');
            await this.setState('info.username', { val: String(json.username ?? ''), ack: true });
        } catch (e) {
            this.log.warn(`fetchUserInfo: ${e.message}`);
        }
    }

    async fetchSubscription() {
        try {
            const json = await this.apiGet('/ownership/subscriptions');
            // API gibt ein Array zurück, aktives Abo suchen
            const subs = Array.isArray(json) ? json : (json.subscriptions ?? []);
            const active = subs.find(s => s.active) ?? subs[0] ?? null;
            if (active) {
                await this.setState('info.subscriptionActive', { val: !!active.active, ack: true });
                await this.setState('info.subscriptionExpires', { val: String(active.expires ?? ''), ack: true });
                await this.setState('info.subscriptionStatus', { val: String(active.status ?? ''), ack: true });
                await this.setState('info.subscriptionLevel', { val: String(active.subscriptionLevel ?? ''), ack: true });
            }
        } catch (e) {
            this.log.warn(`fetchSubscription: ${e.message}`);
        }
    }

    async fetchShoppingList() {
        try {
            const lang = this.loc.language;
            const json = await this.apiGet(`/shopping/${lang}`);

            // Rezepte auf der Einkaufsliste
            const recipes = (json.recipes ?? []).map(r => ({
                id: r.id,
                name: r.title,
                ingredientsCount: (r.recipeIngredientGroups ?? []).length,
            }));
            await this.setState('shopping.recipes', { val: JSON.stringify(recipes), ack: true });
            await this.setState('shopping.recipesCount', { val: recipes.length, ack: true });

            // Zutaten
            const ingredients = (json.items ?? []).map(item => ({
                id: item.id,
                name: item.ingredientNotation ?? item.name ?? '',
                description: this._formatDescription(item),
                is_owned: !!item.isOwned,
            }));
            await this.setState('shopping.ingredientItems', { val: JSON.stringify(ingredients), ack: true });
            await this.setState('shopping.ingredientItemsCount', { val: ingredients.length, ack: true });
            await this.setState('shopping.unownedIngredientsCount', {
                val: ingredients.filter(i => !i.is_owned).length, ack: true,
            });

            // Zusätzliche Artikel
            const additionalItems = (json.additionalItems ?? []).map(item => ({
                id: item.id,
                name: item.name ?? '',
                is_owned: !!item.isOwned,
            }));
            await this.setState('shopping.additionalItems', { val: JSON.stringify(additionalItems), ack: true });
            await this.setState('shopping.additionalItemsCount', { val: additionalItems.length, ack: true });
            await this.setState('shopping.unownedAdditionalCount', {
                val: additionalItems.filter(i => !i.is_owned).length, ack: true,
            });
        } catch (e) {
            this.log.warn(`fetchShoppingList: ${e.message}`);
        }
    }

    async fetchCalendar() {
        try {
            const lang = this.loc.language;
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const json = await this.apiGet(`/planning/${lang}/api/my-week/${today}`);

            const days = Array.isArray(json) ? json : (json.days ?? [json]);
            const week = days.map(day => ({
                id: day.id,
                title: day.title,
                recipes: [
                    ...(day.recipes ?? []).map(r => ({ id: r.id, name: r.title, totalTime: r.totalTime })),
                    ...(day.customerRecipes ?? []).map(r => ({ id: r.id, name: r.title, totalTime: r.totalTime, custom: true })),
                ],
            }));
            await this.setState('calendar.week', { val: JSON.stringify(week), ack: true });

            // Heutigen Tag ermitteln
            const todayTitle = new Date().toLocaleDateString('de-DE', { weekday: 'long' });
            const todayDay = week.find(d =>
                d.id === today ||
                (d.title && d.title.toLowerCase().includes(todayTitle.toLowerCase()))
            ) ?? week[0] ?? null;
            await this.setState('calendar.todayRecipes', {
                val: JSON.stringify(todayDay ? todayDay.recipes : []), ack: true,
            });
        } catch (e) {
            this.log.warn(`fetchCalendar: ${e.message}`);
        }
    }

    async fetchCollections() {
        try {
            const lang = this.loc.language;

            // Vorwerk-Kollektionen
            try {
                const managed = await this.apiGetWithAccept(
                    `/organize/${lang}/api/managed-list`,
                    'application/vnd.vorwerk.organize.managed-list.mobile+json',
                );
                const managedList = (managed.items ?? managed ?? []).map(c => ({
                    id: c.id,
                    name: c.title,
                    chapters: (c.chapters ?? []).map(ch => ({
                        name: ch.title,
                        recipesCount: (ch.recipes ?? []).length,
                    })),
                }));
                await this.setState('collections.managed', { val: JSON.stringify(managedList), ack: true });
                await this.setState('collections.managedCount', { val: managedList.length, ack: true });
            } catch (e) {
                this.log.warn(`fetchManagedCollections: ${e.message}`);
            }

            // Eigene Kollektionen
            try {
                const custom = await this.apiGetWithAccept(
                    `/organize/${lang}/api/custom-list`,
                    'application/vnd.vorwerk.organize.custom-list.mobile+json',
                );
                const customList = (custom.items ?? custom ?? []).map(c => ({
                    id: c.id,
                    name: c.title,
                    description: c.description ?? null,
                    chapters: (c.chapters ?? []).map(ch => ({
                        name: ch.title,
                        recipesCount: (ch.recipes ?? []).length,
                    })),
                }));
                await this.setState('collections.custom', { val: JSON.stringify(customList), ack: true });
                await this.setState('collections.customCount', { val: customList.length, ack: true });
            } catch (e) {
                this.log.warn(`fetchCustomCollections: ${e.message}`);
            }
        } catch (e) {
            this.log.warn(`fetchCollections: ${e.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // Schreibende Aktionen
    // -------------------------------------------------------------------------

    async clearShoppingList() {
        try {
            const lang = this.loc.language;
            // Zuerst alle Rezepte von der Einkaufsliste holen
            const json = await this.apiGet(`/shopping/${lang}`);
            const recipeIds = (json.recipes ?? []).map(r => r.id);

            if (recipeIds.length > 0) {
                await this.apiPost(`/shopping/${lang}/recipes/remove`, { recipeIds });
            }

            // Zusätzliche Artikel entfernen
            const additionalIds = (json.additionalItems ?? []).map(i => i.id);
            if (additionalIds.length > 0) {
                await this.apiPost(`/shopping/${lang}/additional-items/remove`, { ids: additionalIds });
            }

            this.log.info(`Einkaufsliste geleert (${recipeIds.length} Rezept(e), ${additionalIds.length} Zusatzartikel).`);
            await this.fetchShoppingList();
        } catch (e) {
            this.log.error(`clearShoppingList: ${e.message}`);
        }
    }

    /**
     * Alle Rezept-Zutaten als vorhanden / fehlend markieren.
     * @param {boolean} owned
     */
    async markAllIngredientsOwned(owned) {
        try {
            const lang = this.loc.language;
            const json = await this.apiGet(`/shopping/${lang}`);
            const items = json.items ?? [];

            if (items.length === 0) {
                this.log.info('Keine Zutaten auf der Einkaufsliste.');
                return;
            }

            const payload = {
                ownedIngredients: items.map(i => ({ id: i.id, isOwned: owned })),
            };
            await this.apiPost(`/shopping/${lang}/owned-ingredients/ownership/edit`, payload);

            this.log.info(`${items.length} Zutaten als ${owned ? 'vorhanden' : 'fehlend'} markiert.`);
            await this.fetchShoppingList();
        } catch (e) {
            this.log.error(`markAllIngredientsOwned: ${e.message}`);
        }
    }

    // -------------------------------------------------------------------------
    // HTTP-Hilfsmethoden
    // -------------------------------------------------------------------------

    /**
     * Authentifizierter GET-Request gegen die Cookidoo-API.
     * @param {string} path
     * @returns {Promise<any>}
     */
    apiGet(path) {
        return this._apiRequest('GET', path, null, null);
    }

    /**
     * GET mit spezifischem Accept-Header (für Kollektionen nötig).
     * @param {string} path
     * @param {string} accept
     * @returns {Promise<any>}
     */
    apiGetWithAccept(path, accept) {
        return this._apiRequest('GET', path, null, accept);
    }

    /**
     * Authentifizierter POST-Request.
     * @param {string} path
     * @param {object} body
     * @returns {Promise<any>}
     */
    apiPost(path, body) {
        return this._apiRequest('POST', path, body, null);
    }

    /**
     * @param {'GET'|'POST'} method
     * @param {string} path
     * @param {object|null} body
     * @param {string|null} accept
     */
    async _apiRequest(method, path, body, accept) {
        if (!this.authData) throw new Error('Nicht eingeloggt.');

        const cc = this.loc.country_code;
        const bodyStr = body ? JSON.stringify(body) : null;

        const headers = {
            'Accept': accept ?? 'application/json',
            'Authorization': `${this.authData.token_type} ${this.authData.access_token}`,
            'User-Agent': COOKIDOO_USER_AGENT,
            'Cookie': COOKIDOO_COOKIE,
            'Accept-Language': `${this.loc.language};q=1, en;q=0.9`,
            'Accept-Encoding': 'gzip',
        };
        if (bodyStr) {
            headers['Content-Type'] = 'application/json';
            headers['Content-Length'] = Buffer.byteLength(bodyStr);
        }

        return this.httpsRequest({
            hostname: `${cc}.tmmobile.vorwerk-digital.com`,
            path,
            method,
            headers,
        }, bodyStr);
    }

    /**
     * Generischer HTTPS-Request, gibt geparsten JSON zurück.
     * @param {import('node:https').RequestOptions} options
     * @param {string|null} body
     * @returns {Promise<any>}
     */
    httpsRequest(options, body = null) {
        return new Promise((resolve, reject) => {
            const req = https.request({ ...options, timeout: 15000 }, res => {
                let raw = '';
                res.on('data', chunk => (raw += chunk));
                res.on('error', reject);
                res.on('end', () => {
                    if (res.statusCode === 401) {
                        reject(new Error(`HTTP 401 Unauthorized – Token abgelaufen?`));
                        return;
                    }
                    if (res.statusCode === 403) {
                        reject(new Error(`HTTP 403 Forbidden – kein Zugriff auf ${options.path}`));
                        return;
                    }
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`HTTP ${res.statusCode} für ${options.path}: ${raw.slice(0, 200)}`));
                        return;
                    }
                    if (!raw) {
                        resolve({});
                        return;
                    }
                    try {
                        resolve(JSON.parse(raw));
                    } catch {
                        reject(new Error(`Ungültige JSON-Antwort von ${options.path}: ${raw.slice(0, 200)}`));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error(`Timeout für ${options.path}`));
            });

            if (body) req.write(body);
            req.end();
        });
    }

    // -------------------------------------------------------------------------
    // Hilfsmethoden
    // -------------------------------------------------------------------------

    /**
     * Zutatenbeschreibung aus API-Objekt zusammenbauen.
     * @param {any} item
     * @returns {string}
     */
    _formatDescription(item) {
        if (!item.quantity) return '';
        const qty = item.quantity.value
            ?? (item.quantity.from && item.quantity.to
                ? `${item.quantity.from} - ${item.quantity.to}`
                : '');
        return item.unitNotation ? `${qty} ${item.unitNotation}` : String(qty);
    }

    /**
     * Verbindungsfehler loggen — je nach Einstellung als warn oder debug.
     * @param {string} msg
     */
    logConnError(msg) {
        if (this.config.suppressConnectionErrors) {
            this.log.debug(msg);
        } else {
            this.log.warn(msg);
        }
    }
}

if (require.main !== module) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options]
     */
    module.exports = options => new CookidooAdapter(options);
} else {
    new CookidooAdapter();
}
