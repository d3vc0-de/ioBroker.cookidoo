# ioBroker.cookidoo

[![NPM version](https://img.shields.io/npm/v/iobroker.cookidoo.svg)](https://www.npmjs.com/package/iobroker.cookidoo)
[![Downloads](https://img.shields.io/npm/dm/iobroker.cookidoo.svg)](https://www.npmjs.com/package/iobroker.cookidoo)
![Number of Installations](https://iobroker.live/badges/cookidoo-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/cookidoo-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.cookidoo.png?downloads=true)](https://nodei.co/npm/iobroker.cookidoo/)

**Tests:** ![Test and Release](https://github.com/d3vc0-de/ioBroker.cookidoo/workflows/Test%20and%20Release/badge.svg)

## Cookidoo adapter for ioBroker

This adapter integrates the **Cookidoo** recipe and shopping list platform (Thermomix/Vorwerk) into ioBroker. It synchronises your shopping list, weekly meal plan and recipe collections and exposes them as ioBroker states — ready to use in dashboards, scripts and automations.

> **Disclaimer:** This adapter is not affiliated with or endorsed by Vorwerk International & Co. KmG or any of its subsidiaries. Cookidoo® and Thermomix® are registered trademarks of Vorwerk. All product names and trademarks belong to their respective owners. This adapter uses an unofficial, reverse-engineered API and may break at any time if Vorwerk changes their backend.

---

## Features

- Read shopping list: recipes, ingredients (with owned/missing status) and additional items
- Weekly meal plan (calendar) including today's recipes
- Recipe collections (Vorwerk managed + your own custom collections)
- Subscription and account information
- **Action buttons** to trigger from automations:
  - Refresh data on demand
  - Clear the entire shopping list
  - Mark all ingredients as owned or missing

---

## Requirements

- A valid Cookidoo account (email + password)
- An active or trial Cookidoo subscription (free trial is sufficient)
- ioBroker with js-controller ≥ 6.0

---

## Configuration

| Setting | Description |
|---|---|
| **E-Mail address** | The email address you use to log in to Cookidoo |
| **Password** | Your Cookidoo password |
| **Language / Region** | Selects the Cookidoo domain and API endpoint (default: `de-DE`) |
| **Poll interval** | How often to refresh data in seconds (minimum 60 s, default 300 s) |
| **Log connection errors as debug** | When checked, network errors are logged as debug instead of warn |

---

## States

### `info`

| State | Type | Description |
|---|---|---|
| `info.connection` | boolean | `true` = successfully connected to Cookidoo |
| `info.username` | string | Cookidoo account username |
| `info.subscriptionActive` | boolean | `true` = subscription is currently active |
| `info.subscriptionExpires` | string | Expiry date of the subscription |
| `info.subscriptionStatus` | string | Subscription status string from the API |
| `info.subscriptionLevel` | string | Subscription tier (e.g. `PLUS`) |

### `shopping`

All list states contain a **JSON array** that can be parsed in scripts or displayed in JSON widgets.

| State | Type | Description |
|---|---|---|
| `shopping.recipes` | JSON | Recipes currently on the shopping list |
| `shopping.recipesCount` | number | Number of recipes on the shopping list |
| `shopping.ingredientItems` | JSON | Ingredient items with `id`, `name`, `description`, `is_owned` |
| `shopping.ingredientItemsCount` | number | Total number of ingredient items |
| `shopping.unownedIngredientsCount` | number | Number of ingredients not yet marked as owned |
| `shopping.additionalItems` | JSON | Additional (free-text) items with `id`, `name`, `is_owned` |
| `shopping.additionalItemsCount` | number | Total number of additional items |
| `shopping.unownedAdditionalCount` | number | Number of additional items not yet owned |

**Example `shopping.ingredientItems` entry:**
```json
{ "id": "abc123", "name": "Zwiebeln", "description": "2 Stück", "is_owned": false }
```

### `calendar`

| State | Type | Description |
|---|---|---|
| `calendar.week` | JSON | Full week plan — array of days, each with a `recipes` array |
| `calendar.todayRecipes` | JSON | Recipes planned for today only |

**Example `calendar.todayRecipes` entry:**
```json
{ "id": "xyz456", "name": "Tomatensuppe", "totalTime": 1800 }
```

### `collections`

| State | Type | Description |
|---|---|---|
| `collections.managed` | JSON | Vorwerk-curated recipe collections |
| `collections.managedCount` | number | Number of managed collections |
| `collections.custom` | JSON | Your own custom recipe collections |
| `collections.customCount` | number | Number of custom collections |

### `actions`

Write `true` to any of these button states to trigger the corresponding action.

| State | Description |
|---|---|
| `actions.refresh` | Immediately fetch fresh data from Cookidoo |
| `actions.clearShoppingList` | Remove all recipes and additional items from the shopping list |
| `actions.markAllOwned` | Mark all ingredient items on the shopping list as owned |
| `actions.markAllUnowned` | Reset all ingredient items to not owned |

---

## Example: Blockly / Script automation

You can use `shopping.unownedIngredientsCount` to send a notification when all ingredients are in stock:

```js
// JavaScript adapter
on({ id: 'cookidoo.0.shopping.unownedIngredientsCount', change: 'ne' }, obj => {
    if (obj.state.val === 0) {
        sendTo('telegram.0', 'Alle Zutaten vorhanden! Guten Appetit 🍽️');
    }
});
```

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### 0.1.0 (2026-04-12)
* (alex) Initial release

---

## Credits

The API communication in this adapter is based on the research and implementation of the
**[cookidoo-api](https://github.com/miaucl/cookidoo-api)** Python package by
[Cyrill Raccaud (miaucl)](https://github.com/miaucl),
licensed under the MIT License.

The reverse-engineered Cookidoo API endpoints, authentication flow, request formats and
data structures were taken directly from that project. Without this foundational work,
this adapter would not exist.

```
MIT License
Copyright (c) 2024 Cyrill Raccaud cyrill.raccaud+pypi@gmail.com
```

---

## License

MIT License

Copyright (c) 2026 alex <d3vc0_de@proton.me>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
