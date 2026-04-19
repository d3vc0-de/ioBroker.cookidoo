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
	 * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
	 */
	constructor(options) {
		super({ ...options, name: 'cookidoo' });
		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		this.on('unload', this.onUnload.bind(this));

		this.pollTimer = null;
		this.authData = null;
		this.tokenExpiresAt = 0;
		this.loc = LOCALIZATIONS['de-DE'];
	}

	// -------------------------------------------------------------------------
	// Lifecycle
	// -------------------------------------------------------------------------

	async onReady() {
		if (!this.config.email || !this.config.password) {
			this.log.error('E-Mail und Passwort müssen in den Adapter-Einstellungen konfiguriert sein.');
			this.terminate ? this.terminate('E-Mail oder Passwort fehlt') : process.exit(1);
			return;
		}

		this.loc = LOCALIZATIONS[this.config.language] ?? LOCALIZATIONS['de-DE'];
		this.log.info(
			`Cookidoo Adapter gestartet (${this.config.language}, Abfrageintervall: ${this.config.pollInterval}s)`,
		);

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
	 * @param {string} id - State ID
	 * @param {ioBroker.State | null | undefined} state - State value
	 */
	async onStateChange(id, state) {
		if (!state || state.ack) {
			return;
		}
		const localId = id.replace(`${this.namespace}.`, '');
		await this._handleAction(localId, state.val);
	}

	/**
	 * @param {string} localId - Local state ID
	 * @param {any} val - State value
	 */
	async _handleAction(localId, val) {
		const ack = async () => {
			const isButton = [
				'actions.refresh',
				'actions.clearShoppingList',
				'actions.markAllOwned',
				'actions.markAllUnowned',
			].includes(localId);
			await this.setState(localId, { val: isButton ? false : '', ack: true });
		};

		try {
			switch (localId) {
				// ---- Buttons ----
				case 'actions.refresh':
					this.log.info('Manuelle Aktualisierung ausgelöst.');
					await this.safePoll();
					break;

				case 'actions.clearShoppingList':
					this.log.info('Einkaufsliste wird geleert...');
					await this.clearShoppingList();
					break;

				case 'actions.markAllOwned':
					this.log.info('Alle Zutaten als vorhanden markieren...');
					await this.markAllIngredientsOwned(true);
					break;

				case 'actions.markAllUnowned':
					this.log.info('Alle Zutaten als nicht vorhanden markieren...');
					await this.markAllIngredientsOwned(false);
					break;

				// ---- Einkaufsliste: Rezepte ----
				case 'actions.addRecipeToShopping':
					if (val) {
						this.log.info(`Rezept ${val} zur Einkaufsliste hinzufügen...`);
						await this.addRecipesToShopping([String(val)]);
						await this.fetchShoppingList();
					}
					break;

				case 'actions.removeRecipeFromShopping':
					if (val) {
						this.log.info(`Rezept ${val} von der Einkaufsliste entfernen...`);
						await this.removeRecipesFromShopping([String(val)]);
						await this.fetchShoppingList();
					}
					break;

				// ---- Einkaufsliste: Zusatzartikel ----
				case 'actions.addAdditionalItem':
					if (val) {
						this.log.info(`Zusatzartikel "${val}" hinzufügen...`);
						await this.addAdditionalItem(String(val));
						await this.fetchShoppingList();
					}
					break;

				case 'actions.removeAdditionalItem':
					if (val) {
						this.log.info(`Zusatzartikel ${val} entfernen...`);
						await this.removeAdditionalItems([String(val)]);
						await this.fetchShoppingList();
					}
					break;

				// ---- Kalender ----
				case 'actions.addRecipeToCalendar': {
					// Erwartet JSON-String: {"date":"2026-04-12","recipeId":"r123456"}
					if (val) {
						const data = this._parseJson(val, 'addRecipeToCalendar');
						if (data && data.date && data.recipeId) {
							this.log.info(`Rezept ${data.recipeId} am ${data.date} planen...`);
							await this.addRecipeToCalendar(data.date, [data.recipeId]);
							await this.fetchCalendar();
						}
					}
					break;
				}

				case 'actions.removeRecipeFromCalendar': {
					// Erwartet JSON-String: {"date":"2026-04-12","recipeId":"r123456"}
					if (val) {
						const data = this._parseJson(val, 'removeRecipeFromCalendar');
						if (data && data.date && data.recipeId) {
							this.log.info(`Rezept ${data.recipeId} am ${data.date} entfernen...`);
							await this.removeRecipeFromCalendar(data.date, data.recipeId);
							await this.fetchCalendar();
						}
					}
					break;
				}

				// ---- Eigene Rezepte ----
				case 'actions.copyRecipeUrl': {
					// Erwartet eine Cookidoo-URL, z.B. https://cookidoo.de/recipes/recipe/de-DE/r123456
					if (val) {
						this.log.info(`Rezept kopieren: ${val}`);
						await this.copyCustomRecipe(String(val), 4);
						await this.fetchCustomRecipes();
					}
					break;
				}

				case 'actions.deleteCustomRecipe':
					if (val) {
						this.log.info(`Eigenes Rezept ${val} löschen...`);
						await this.deleteCustomRecipe(String(val));
						await this.fetchCustomRecipes();
					}
					break;

				// ---- Kollektionen ----
				case 'actions.addManagedCollection':
					if (val) {
						this.log.info(`Vorwerk-Kollektion ${val} hinzufügen...`);
						await this.addManagedCollection(String(val));
						await this.fetchCollections();
					}
					break;

				case 'actions.removeManagedCollection':
					if (val) {
						this.log.info(`Vorwerk-Kollektion ${val} entfernen...`);
						await this.removeManagedCollection(String(val));
						await this.fetchCollections();
					}
					break;

				case 'actions.addCustomCollection':
					if (val) {
						this.log.info(`Eigene Kollektion "${val}" anlegen...`);
						await this.addCustomCollection(String(val));
						await this.fetchCollections();
					}
					break;

				case 'actions.removeCustomCollection':
					if (val) {
						this.log.info(`Eigene Kollektion ${val} löschen...`);
						await this.removeCustomCollection(String(val));
						await this.fetchCollections();
					}
					break;
			}
		} catch (e) {
			this.log.error(`Aktion ${localId} fehlgeschlagen: ${e.message}`);
		}
		await ack();
	}

	// -------------------------------------------------------------------------
	// ioBroker Objekte anlegen
	// -------------------------------------------------------------------------

	async createObjects() {
		const shopping = this.config.enableShopping !== false;
		const calendar = this.config.enableCalendar !== false;
		const customRec = this.config.enableCustomRecipes !== false;
		const managedColl = this.config.enableManagedCollections !== false;
		const customColl = this.config.enableCustomCollections !== false;

		// --- info (immer) ---
		await this.setObjectNotExistsAsync('info', {
			type: 'channel',
			common: { name: 'Informationen' },
			native: {},
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
		if (shopping) {
			await this.setObjectNotExistsAsync('shopping', {
				type: 'channel',
				common: { name: 'Einkaufsliste' },
				native: {},
			});
			await this.setObjectNotExistsAsync('shopping.recipes', {
				type: 'state',
				common: {
					name: 'Rezepte auf der Einkaufsliste (JSON)',
					type: 'string',
					role: 'json',
					read: true,
					write: false,
					def: '[]',
				},
				native: {},
			});
			await this.setObjectNotExistsAsync('shopping.recipesCount', {
				type: 'state',
				common: { name: 'Anzahl Rezepte', type: 'number', role: 'value', read: true, write: false, def: 0 },
				native: {},
			});
			await this.setObjectNotExistsAsync('shopping.ingredientItems', {
				type: 'state',
				common: { name: 'Zutaten (JSON)', type: 'string', role: 'json', read: true, write: false, def: '[]' },
				native: {},
			});
			await this.setObjectNotExistsAsync('shopping.ingredientItemsCount', {
				type: 'state',
				common: { name: 'Anzahl Zutaten', type: 'number', role: 'value', read: true, write: false, def: 0 },
				native: {},
			});
			await this.setObjectNotExistsAsync('shopping.unownedIngredientsCount', {
				type: 'state',
				common: { name: 'Fehlende Zutaten', type: 'number', role: 'value', read: true, write: false, def: 0 },
				native: {},
			});
			await this.setObjectNotExistsAsync('shopping.additionalItems', {
				type: 'state',
				common: {
					name: 'Zusätzliche Artikel (JSON)',
					type: 'string',
					role: 'json',
					read: true,
					write: false,
					def: '[]',
				},
				native: {},
			});
			await this.setObjectNotExistsAsync('shopping.additionalItemsCount', {
				type: 'state',
				common: {
					name: 'Anzahl zusätzliche Artikel',
					type: 'number',
					role: 'value',
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
			await this.setObjectNotExistsAsync('shopping.unownedAdditionalCount', {
				type: 'state',
				common: {
					name: 'Fehlende zusätzliche Artikel',
					type: 'number',
					role: 'value',
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
		} else {
			await this.delObjectAsync('shopping', { recursive: true }).catch(() => {});
		}

		// --- calendar ---
		if (calendar) {
			await this.setObjectNotExistsAsync('calendar', {
				type: 'channel',
				common: { name: 'Wochenkalender' },
				native: {},
			});
			await this.setObjectNotExistsAsync('calendar.week', {
				type: 'state',
				common: {
					name: 'Aktuelle Woche (JSON)',
					type: 'string',
					role: 'json',
					read: true,
					write: false,
					def: '[]',
				},
				native: {},
			});
			await this.setObjectNotExistsAsync('calendar.todayRecipes', {
				type: 'state',
				common: {
					name: 'Rezepte heute (JSON)',
					type: 'string',
					role: 'json',
					read: true,
					write: false,
					def: '[]',
				},
				native: {},
			});
		} else {
			await this.delObjectAsync('calendar', { recursive: true }).catch(() => {});
		}

		// --- customRecipes ---
		if (customRec) {
			await this.setObjectNotExistsAsync('customRecipes', {
				type: 'channel',
				common: { name: 'Meine Rezepte' },
				native: {},
			});
			await this.setObjectNotExistsAsync('customRecipes.list', {
				type: 'state',
				common: {
					name: 'Eigene / kopierte Rezepte (JSON)',
					type: 'string',
					role: 'json',
					read: true,
					write: false,
					def: '[]',
				},
				native: {},
			});
			await this.setObjectNotExistsAsync('customRecipes.count', {
				type: 'state',
				common: {
					name: 'Anzahl eigene Rezepte',
					type: 'number',
					role: 'value',
					read: true,
					write: false,
					def: 0,
				},
				native: {},
			});
		} else {
			await this.delObjectAsync('customRecipes', { recursive: true }).catch(() => {});
		}

		// --- collections ---
		if (managedColl || customColl) {
			await this.setObjectNotExistsAsync('collections', {
				type: 'channel',
				common: { name: 'Kollektionen' },
				native: {},
			});
			if (managedColl) {
				await this.setObjectNotExistsAsync('collections.managed', {
					type: 'state',
					common: {
						name: 'Vorwerk-Kollektionen (JSON)',
						type: 'string',
						role: 'json',
						read: true,
						write: false,
						def: '[]',
					},
					native: {},
				});
				await this.setObjectNotExistsAsync('collections.managedCount', {
					type: 'state',
					common: {
						name: 'Anzahl Vorwerk-Kollektionen',
						type: 'number',
						role: 'value',
						read: true,
						write: false,
						def: 0,
					},
					native: {},
				});
			} else {
				await this.delObjectAsync('collections.managed').catch(() => {});
				await this.delObjectAsync('collections.managedCount').catch(() => {});
			}
			if (customColl) {
				await this.setObjectNotExistsAsync('collections.custom', {
					type: 'state',
					common: {
						name: 'Eigene Kollektionen (JSON)',
						type: 'string',
						role: 'json',
						read: true,
						write: false,
						def: '[]',
					},
					native: {},
				});
				await this.setObjectNotExistsAsync('collections.customCount', {
					type: 'state',
					common: {
						name: 'Anzahl eigene Kollektionen',
						type: 'number',
						role: 'value',
						read: true,
						write: false,
						def: 0,
					},
					native: {},
				});
			} else {
				await this.delObjectAsync('collections.custom').catch(() => {});
				await this.delObjectAsync('collections.customCount').catch(() => {});
			}
		} else {
			await this.delObjectAsync('collections', { recursive: true }).catch(() => {});
		}

		// --- actions ---
		await this.setObjectNotExistsAsync('actions', {
			type: 'channel',
			common: { name: 'Aktionen' },
			native: {},
		});

		// Immer: Refresh-Button
		await this.setObjectNotExistsAsync('actions.refresh', {
			type: 'state',
			common: {
				name: 'Daten aktualisieren',
				type: 'boolean',
				role: 'button',
				read: false,
				write: true,
				def: false,
			},
			native: {},
		});

		// Shopping-Buttons und -Aktionen
		if (shopping) {
			for (const [id, name] of [
				['actions.clearShoppingList', 'Einkaufsliste leeren'],
				['actions.markAllOwned', 'Alle Zutaten als vorhanden markieren'],
				['actions.markAllUnowned', 'Alle Zutaten als fehlend markieren'],
			]) {
				await this.setObjectNotExistsAsync(id, {
					type: 'state',
					common: { name, type: 'boolean', role: 'button', read: false, write: true, def: false },
					native: {},
				});
			}
			for (const [id, name, desc] of [
				['actions.addRecipeToShopping', 'Rezept zur Einkaufsliste hinzufügen', 'Rezept-ID, z.B. r123456'],
				[
					'actions.removeRecipeFromShopping',
					'Rezept von der Einkaufsliste entfernen',
					'Rezept-ULID aus shopping.recipes',
				],
				['actions.addAdditionalItem', 'Zusatzartikel hinzufügen', 'Artikelname als Text'],
				['actions.removeAdditionalItem', 'Zusatzartikel entfernen', 'Artikel-ID aus shopping.additionalItems'],
			]) {
				await this.setObjectNotExistsAsync(id, {
					type: 'state',
					common: { name, type: 'string', role: 'text', read: true, write: true, def: '', desc },
					native: {},
				});
			}
		} else {
			for (const id of [
				'actions.clearShoppingList',
				'actions.markAllOwned',
				'actions.markAllUnowned',
				'actions.addRecipeToShopping',
				'actions.removeRecipeFromShopping',
				'actions.addAdditionalItem',
				'actions.removeAdditionalItem',
			]) {
				await this.delObjectAsync(id).catch(() => {});
			}
		}

		// Kalender-Aktionen
		if (calendar) {
			for (const [id, name, desc] of [
				[
					'actions.addRecipeToCalendar',
					'Rezept zum Kalender hinzufügen',
					'JSON: {"date":"2026-04-12","recipeId":"r123456"}',
				],
				[
					'actions.removeRecipeFromCalendar',
					'Rezept aus Kalender entfernen',
					'JSON: {"date":"2026-04-12","recipeId":"r123456"}',
				],
			]) {
				await this.setObjectNotExistsAsync(id, {
					type: 'state',
					common: { name, type: 'string', role: 'json', read: true, write: true, def: '', desc },
					native: {},
				});
			}
		} else {
			for (const id of ['actions.addRecipeToCalendar', 'actions.removeRecipeFromCalendar']) {
				await this.delObjectAsync(id).catch(() => {});
			}
		}

		// Eigene Rezepte-Aktionen
		if (customRec) {
			for (const [id, name, desc] of [
				[
					'actions.copyRecipeUrl',
					'Rezept in "Meine Rezepte" kopieren',
					'Vollständige Cookidoo-URL, z.B. https://cookidoo.de/recipes/recipe/de-DE/r123456',
				],
				['actions.deleteCustomRecipe', 'Eigenes Rezept löschen', 'Rezept-ID aus customRecipes.list'],
			]) {
				await this.setObjectNotExistsAsync(id, {
					type: 'state',
					common: { name, type: 'string', role: 'text', read: true, write: true, def: '', desc },
					native: {},
				});
			}
		} else {
			for (const id of ['actions.copyRecipeUrl', 'actions.deleteCustomRecipe']) {
				await this.delObjectAsync(id).catch(() => {});
			}
		}

		// Kollektions-Aktionen
		if (managedColl) {
			for (const [id, name, desc] of [
				['actions.addManagedCollection', 'Vorwerk-Kollektion hinzufügen', 'Kollektions-ID'],
				[
					'actions.removeManagedCollection',
					'Vorwerk-Kollektion entfernen',
					'Kollektions-ID aus collections.managed',
				],
			]) {
				await this.setObjectNotExistsAsync(id, {
					type: 'state',
					common: { name, type: 'string', role: 'text', read: true, write: true, def: '', desc },
					native: {},
				});
			}
		} else {
			for (const id of ['actions.addManagedCollection', 'actions.removeManagedCollection']) {
				await this.delObjectAsync(id).catch(() => {});
			}
		}

		if (customColl) {
			for (const [id, name, desc] of [
				['actions.addCustomCollection', 'Eigene Kollektion anlegen', 'Titel der neuen Kollektion'],
				[
					'actions.removeCustomCollection',
					'Eigene Kollektion löschen',
					'Kollektions-ID aus collections.custom',
				],
			]) {
				await this.setObjectNotExistsAsync(id, {
					type: 'state',
					common: { name, type: 'string', role: 'text', read: true, write: true, def: '', desc },
					native: {},
				});
			}
		} else {
			for (const id of ['actions.addCustomCollection', 'actions.removeCustomCollection']) {
				await this.delObjectAsync(id).catch(() => {});
			}
		}
	}

	// -------------------------------------------------------------------------
	// Poll
	// -------------------------------------------------------------------------

	async safePoll() {
		try {
			if (this.authData && this.tokenExpiresAt && Date.now() > this.tokenExpiresAt - 60_000) {
				await this.refreshToken();
			}
			await this.poll();
		} catch (e) {
			this.logConnError(`Poll fehlgeschlagen: ${e.message}`);
			await this.setState('info.connection', { val: false, ack: true });
		}
	}

	async poll() {
		const tasks = [this.fetchUserInfo(), this.fetchSubscription()];
		if (this.config.enableShopping !== false) {
			tasks.push(this.fetchShoppingList());
		}
		if (this.config.enableCalendar !== false) {
			tasks.push(this.fetchCalendar());
		}
		if (this.config.enableCustomRecipes !== false) {
			tasks.push(this.fetchCustomRecipes());
		}
		if (this.config.enableManagedCollections !== false || this.config.enableCustomCollections !== false) {
			tasks.push(this.fetchCollections());
		}
		await Promise.allSettled(tasks);
		await this.setState('info.connection', { val: true, ack: true });
	}

	// -------------------------------------------------------------------------
	// Authentifizierung
	// -------------------------------------------------------------------------

	async login() {
		// Laut Raw-API-Mitschnitt: kein client_id im Login-Body
		const body = querystring.stringify({
			grant_type: 'password',
			username: this.config.email,
			password: this.config.password,
		});
		await this._requestToken(body);
		this.log.info('Cookidoo Login erfolgreich.');
	}

	async refreshToken() {
		if (!this.authData) {
			throw new Error('Kein Auth-Token vorhanden – bitte neu einloggen.');
		}
		const body = querystring.stringify({
			grant_type: 'refresh_token',
			refresh_token: this.authData.refresh_token,
			client_id: 'kupferwerk-client-nwot',
		});
		await this._requestToken(body);
		this.log.debug('Token erneuert.');
	}

	async _requestToken(body) {
		const json = await this.httpsRequest(
			{
				hostname: `${this.loc.country_code}.tmmobile.vorwerk-digital.com`,
				path: '/ciam/auth/token',
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/x-www-form-urlencoded',
					Authorization: COOKIDOO_AUTH_HEADER,
					'User-Agent': COOKIDOO_USER_AGENT,
					Cookie: COOKIDOO_COOKIE,
					'Accept-Language': `${this.loc.language};q=1, en;q=0.9`,
					'Content-Length': Buffer.byteLength(body),
				},
			},
			body,
		);
		this.authData = json;
		this.tokenExpiresAt = Date.now() + json.expires_in * 1000;
	}

	// -------------------------------------------------------------------------
	// Lesende API-Aufrufe
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
			const subs = Array.isArray(json) ? json : (json.subscriptions ?? []);
			const active = subs.find(s => s.active) ?? subs[0] ?? null;
			if (active) {
				await this.setState('info.subscriptionActive', { val: !!active.active, ack: true });
				await this.setState('info.subscriptionExpires', { val: String(active.expires ?? ''), ack: true });
				await this.setState('info.subscriptionStatus', { val: String(active.status ?? ''), ack: true });
				await this.setState('info.subscriptionLevel', {
					val: String(active.subscriptionLevel ?? ''),
					ack: true,
				});
			}
		} catch (e) {
			this.log.warn(`fetchSubscription: ${e.message}`);
		}
	}

	async fetchShoppingList() {
		try {
			const lang = this.loc.language;
			const json = await this.apiGet(`/shopping/${lang}`);

			// Rezepte (id = ULID, wird zum Entfernen benötigt)
			const recipes = (json.recipes ?? []).map(r => {
				const imgs = this._extractImages(r.descriptiveAssets);
				return {
					id: r.id, // ULID
					name: r.title ?? '',
					locale: r.locale ?? '',
					ingredientsCount: (r.recipeIngredientGroups ?? []).length,
					thumbnail: imgs.thumbnail,
					image: imgs.image,
				};
			});
			await this.setState('shopping.recipes', { val: JSON.stringify(recipes), ack: true });
			await this.setState('shopping.recipesCount', { val: recipes.length, ack: true });

			// Zutaten
			const ingredients = (json.items ?? []).map(item => ({
				id: item.id,
				name: item.ingredientNotation ?? item.name ?? '',
				description: this._formatDescription(item),
				is_owned: !!item.isOwned,
				optional: !!item.optional,
				category: item.shoppingCategory_ref ?? null,
			}));
			await this.setState('shopping.ingredientItems', { val: JSON.stringify(ingredients), ack: true });
			await this.setState('shopping.ingredientItemsCount', { val: ingredients.length, ack: true });
			await this.setState('shopping.unownedIngredientsCount', {
				val: ingredients.filter(i => !i.is_owned).length,
				ack: true,
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
				val: additionalItems.filter(i => !i.is_owned).length,
				ack: true,
			});
		} catch (e) {
			this.log.warn(`fetchShoppingList: ${e.message}`);
		}
	}

	async fetchCalendar() {
		try {
			const lang = this.loc.language;
			const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
			const json = await this.apiGetWithAccept(
				`/planning/${lang}/api/my-week/${today}`,
				'application/vnd.vorwerk.planning.my-day.mobile+json',
			);

			const days = json.myDays ?? [];
			const week = days.map(day => ({
				id: day.id,
				title: day.title,
				recipes: (day.recipes ?? []).map(r => {
					const imgs = this._extractImages(r.assets);
					return {
						id: r.id,
						name: r.title ?? '',
						totalTime: Number(r.totalTime ?? 0),
						locale: r.locale ?? '',
						thumbnail: imgs.thumbnail,
						image: imgs.image,
					};
				}),
				customRecipeIds: day.customerRecipeIds ?? [],
			}));
			await this.setState('calendar.week', { val: JSON.stringify(week), ack: true });

			const todayDay = week.find(d => d.id === today) ?? null;
			await this.setState('calendar.todayRecipes', {
				val: JSON.stringify(todayDay ? todayDay.recipes : []),
				ack: true,
			});
		} catch (e) {
			this.log.warn(`fetchCalendar: ${e.message}`);
		}
	}

	async fetchCustomRecipes() {
		try {
			const lang = this.loc.language;
			const json = await this.apiGetWithAccept(
				`/created-recipes/${lang}`,
				'application/vnd.vorwerk.customer-recipe.full+json',
			);
			const items = (json.items ?? []).map(r => {
				const content = r.recipeContent ?? {};
				const imgs = this._extractImages(content.descriptiveAssets ?? content.image);
				return {
					id: r.recipeId,
					name: content.name ?? '',
					servingSize: content.yield?.value ?? 0,
					totalTime: content.totalTime ?? 0,
					prepTime: content.prepTime ?? 0,
					status: r.status ?? '',
					workStatus: r.workStatus ?? '',
					basedOn: content.isBasedOn ?? null,
					tools: content.tools ?? [],
					ingredients: (content.ingredients ?? []).filter(i => i.type === 'INGREDIENT').map(i => i.text),
					thumbnail: imgs.thumbnail,
					image: imgs.image,
					createdAt: r.createdAt ?? null,
					modifiedAt: r.modifiedAt ?? null,
				};
			});
			await this.setState('customRecipes.list', { val: JSON.stringify(items), ack: true });
			await this.setState('customRecipes.count', { val: items.length, ack: true });
		} catch (e) {
			this.log.warn(`fetchCustomRecipes: ${e.message}`);
		}
	}

	async fetchCollections() {
		const lang = this.loc.language;

		if (this.config.enableManagedCollections !== false) {
			try {
				const managed = await this.apiGetWithAccept(
					`/organize/${lang}/api/managed-list`,
					'application/vnd.vorwerk.organize.managed-list.mobile+json',
				);
				const managedList = (managed.managedlists ?? []).map(c => {
					const imgs = this._extractImages(c.assets);
					return {
						id: c.id,
						name: c.title ?? '',
						description: c.description ?? null,
						author: c.author ?? null,
						created: c.created ?? null,
						modified: c.modified ?? null,
						thumbnail: imgs.thumbnail,
						image: imgs.image,
						chapters: (c.chapters ?? []).map(ch => ({
							name: ch.title ?? '',
							recipes: (ch.recipes ?? []).map(r => {
								const ri = this._extractImages(r.assets);
								return {
									id: r.id,
									name: r.title ?? '',
									totalTime: Number(r.totalTime ?? 0),
									thumbnail: ri.thumbnail,
								};
							}),
						})),
					};
				});
				await this.setState('collections.managed', { val: JSON.stringify(managedList), ack: true });
				await this.setState('collections.managedCount', { val: managedList.length, ack: true });
			} catch (e) {
				this.log.warn(`fetchManagedCollections: ${e.message}`);
			}
		}

		if (this.config.enableCustomCollections !== false) {
			try {
				const custom = await this.apiGetWithAccept(
					`/organize/${lang}/api/custom-list`,
					'application/vnd.vorwerk.organize.custom-list.mobile+json',
				);
				const customList = (custom.customlists ?? []).map(c => {
					const imgs = this._extractImages(c.assets);
					return {
						id: c.id,
						name: c.title ?? '',
						description: c.description ?? null,
						shared: !!c.shared,
						sharedListId: c.sharedListId ?? null,
						created: c.created ?? null,
						modified: c.modified ?? null,
						thumbnail: imgs.thumbnail,
						image: imgs.image,
						chapters: (c.chapters ?? []).map(ch => ({
							name: ch.title ?? '',
							recipes: (ch.recipes ?? []).map(r => ({
								id: r.id,
								name: r.title ?? '',
							})),
						})),
					};
				});
				await this.setState('collections.custom', { val: JSON.stringify(customList), ack: true });
				await this.setState('collections.customCount', { val: customList.length, ack: true });
			} catch (e) {
				this.log.warn(`fetchCustomCollections: ${e.message}`);
			}
		}
	}

	// -------------------------------------------------------------------------
	// Schreibende API-Aufrufe: Einkaufsliste
	// -------------------------------------------------------------------------

	async clearShoppingList() {
		// DELETE /shopping/{language} löscht alles auf einmal
		const lang = this.loc.language;
		await this.apiDelete(`/shopping/${lang}`);
		this.log.info('Einkaufsliste geleert.');
		await this.fetchShoppingList();
	}

	/**
	 * @param {string[]} recipeIDs  Rezept-IDs (r123456) zum Hinzufügen
	 */
	async addRecipesToShopping(recipeIDs) {
		const lang = this.loc.language;
		await this.apiPost(`/shopping/${lang}/recipes/add`, { recipeIDs });
	}

	/**
	 * @param {string[]} recipeIDs  ULIDs aus shopping.recipes[].id
	 */
	async removeRecipesFromShopping(recipeIDs) {
		const lang = this.loc.language;
		await this.apiPost(`/shopping/${lang}/recipes/remove`, { recipeIDs });
	}

	/**
	 * @param {string} itemName - Item name
	 */
	async addAdditionalItem(itemName) {
		const lang = this.loc.language;
		await this.apiPost(`/shopping/${lang}/additional-items/add`, { itemsValue: [itemName] });
	}

	/**
	 * @param {string[]} additionalItemIDs - List of item IDs
	 */
	async removeAdditionalItems(additionalItemIDs) {
		const lang = this.loc.language;
		await this.apiPost(`/shopping/${lang}/additional-items/remove`, { additionalItemIDs });
	}

	/**
	 * @param {boolean} owned - Owned status
	 */
	async markAllIngredientsOwned(owned) {
		const lang = this.loc.language;
		const json = await this.apiGet(`/shopping/${lang}`);
		const items = json.items ?? [];
		if (items.length === 0) {
			this.log.info('Keine Zutaten auf der Einkaufsliste.');
			return;
		}
		const ts = Date.now();
		await this.apiPost(`/shopping/${lang}/owned-ingredients/ownership/edit`, {
			ingredients: items.map(i => ({ id: i.id, isOwned: owned, ownedTimestamp: ts })),
		});
		this.log.info(`${items.length} Zutat(en) als ${owned ? 'vorhanden' : 'fehlend'} markiert.`);
		await this.fetchShoppingList();
	}

	// -------------------------------------------------------------------------
	// Schreibende API-Aufrufe: Kalender
	// -------------------------------------------------------------------------

	/**
	 * @param {string} dayKey   YYYY-MM-DD
	 * @param {string[]} recipeIds
	 */
	async addRecipeToCalendar(dayKey, recipeIds) {
		const lang = this.loc.language;
		await this.apiPut(`/planning/${lang}/api/my-day`, { dayKey, recipeIds });
	}

	/**
	 * @param {string} dayKey     YYYY-MM-DD
	 * @param {string} recipeId
	 */
	async removeRecipeFromCalendar(dayKey, recipeId) {
		const lang = this.loc.language;
		await this.apiDelete(`/planning/${lang}/api/my-day/${dayKey}/recipes/${recipeId}`);
	}

	// -------------------------------------------------------------------------
	// Schreibende API-Aufrufe: Eigene Rezepte
	// -------------------------------------------------------------------------

	/**
	 * Kopiert ein bestehendes Cookidoo-Rezept in "Meine Rezepte".
	 *
	 * @param {string} recipeUrl   Vollständige Cookidoo-URL
	 * @param {number} servingSize Portionen
	 */
	async copyCustomRecipe(recipeUrl, servingSize = 4) {
		const lang = this.loc.language;
		await this.apiPost(`/created-recipes/${lang}`, { recipeUrl, servingSize });
		this.log.info(`Rezept kopiert: ${recipeUrl}`);
	}

	/**
	 * @param {string} recipeId  ID aus customRecipes.list[].id
	 */
	async deleteCustomRecipe(recipeId) {
		const lang = this.loc.language;
		await this.apiDelete(`/created-recipes/${lang}/${recipeId}`);
	}

	// -------------------------------------------------------------------------
	// Schreibende API-Aufrufe: Kollektionen
	// -------------------------------------------------------------------------

	async addManagedCollection(collectionId) {
		const lang = this.loc.language;
		await this.apiPost(`/organize/${lang}/api/managed-list`, { id: collectionId });
	}

	async removeManagedCollection(collectionId) {
		const lang = this.loc.language;
		await this.apiDelete(`/organize/${lang}/api/managed-list/${collectionId}`);
	}

	async addCustomCollection(title) {
		const lang = this.loc.language;
		await this.apiPost(`/organize/${lang}/api/custom-list`, {
			title,
			chapters: [{ title: '', recipes: [] }],
		});
	}

	async removeCustomCollection(collectionId) {
		const lang = this.loc.language;
		await this.apiDelete(`/organize/${lang}/api/custom-list/${collectionId}`);
	}

	// -------------------------------------------------------------------------
	// HTTP-Hilfsmethoden
	// -------------------------------------------------------------------------

	apiGet(path) {
		return this._apiRequest('GET', path, null, null);
	}

	apiGetWithAccept(path, accept) {
		return this._apiRequest('GET', path, null, accept);
	}

	apiPost(path, body) {
		return this._apiRequest('POST', path, body, null);
	}

	apiPut(path, body) {
		return this._apiRequest('PUT', path, body, null);
	}

	apiDelete(path) {
		return this._apiRequest('DELETE', path, null, null);
	}

	async _apiRequest(method, path, body, accept) {
		if (!this.authData) {
			throw new Error('Nicht eingeloggt.');
		}
		const bodyStr = body ? JSON.stringify(body) : null;
		const headers = {
			Accept: accept ?? 'application/json',
			Authorization: `${this.authData.token_type} ${this.authData.access_token}`,
			'User-Agent': COOKIDOO_USER_AGENT,
			Cookie: COOKIDOO_COOKIE,
			'Accept-Language': `${this.loc.language};q=1, en;q=0.9`,
		};
		if (bodyStr) {
			headers['Content-Type'] = 'application/json; charset=UTF-8';
			headers['Content-Length'] = Buffer.byteLength(bodyStr);
		}
		return this.httpsRequest(
			{
				hostname: `${this.loc.country_code}.tmmobile.vorwerk-digital.com`,
				path,
				method,
				headers,
			},
			bodyStr,
		);
	}

	/**
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
						reject(new Error('HTTP 401 – Token abgelaufen'));
						return;
					}
					if (res.statusCode === 403) {
						reject(new Error(`HTTP 403 – kein Zugriff auf ${options.path}`));
						return;
					}
					if (res.statusCode && res.statusCode >= 400) {
						reject(new Error(`HTTP ${res.statusCode} für ${options.path}: ${raw.slice(0, 300)}`));
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
			if (body) {
				req.write(body);
			}
			req.end();
		});
	}

	// -------------------------------------------------------------------------
	// Hilfsmethoden
	// -------------------------------------------------------------------------

	/**
	 * Thumbnail/Image URLs aus verschiedenen API-Antwortformaten extrahieren.
	 * Unterstützt: descriptiveAssets[] (Array), assets.images (Objekt), direkte URL (string).
	 * Ersetzt {transformation} laut miaucl/cookidoo-api helpers.py.
	 *
	 * @param {any} assets
	 * @returns {{ thumbnail: string|null, image: string|null }}
	 */
	_extractImages(assets) {
		let raw = null;
		if (typeof assets === 'string' && assets.includes('{transformation}')) {
			raw = assets;
		} else if (Array.isArray(assets)) {
			for (const a of assets) {
				raw = a.square || a.portrait || a.landscape;
				if (raw) {
					break;
				}
			}
		} else if (assets?.images) {
			raw = assets.images.square || assets.images.portrait || assets.images.landscape;
		}
		if (!raw) {
			return { thumbnail: null, image: null };
		}
		return {
			thumbnail: raw.replace('{transformation}', 't_web_shared_recipe_221x240'),
			image: raw.replace('{transformation}', 't_web_rdp_recipe_584x480_1_5x'),
		};
	}

	_formatDescription(item) {
		if (!item.quantity) {
			return '';
		}
		const qty =
			item.quantity.value != null
				? item.quantity.value
				: item.quantity.from && item.quantity.to
					? `${item.quantity.from} - ${item.quantity.to}`
					: '';
		return item.unitNotation ? `${qty} ${item.unitNotation}` : String(qty);
	}

	/**
	 * JSON sicher parsen — gibt null zurück und loggt bei Fehler.
	 *
	 * @param {string} val
	 * @param {string} context
	 */
	_parseJson(val, context) {
		try {
			return JSON.parse(val);
		} catch {
			this.log.error(`${context}: Ungültiges JSON: ${val}`);
			return null;
		}
	}

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
