# ioBroker.cookidoo

[![NPM version](https://img.shields.io/npm/v/iobroker.cookidoo.svg)](https://www.npmjs.com/package/iobroker.cookidoo)
[![Downloads](https://img.shields.io/npm/dm/iobroker.cookidoo.svg)](https://www.npmjs.com/package/iobroker.cookidoo)
![Number of Installations](https://iobroker.live/badges/cookidoo-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/cookidoo-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.cookidoo.png?downloads=true)](https://nodei.co/npm/iobroker.cookidoo/)

**Tests:** ![Test and Release](https://github.com/d3vc0-de/ioBroker.cookidoo/workflows/Test%20and%20Release/badge.svg)

## Cookidoo adapter for ioBroker

This adapter integrates the **Cookidoo** recipe and shopping list platform (Thermomix/Vorwerk) into ioBroker. It synchronises your shopping list, weekly meal plan, personal recipe library and recipe collections — and exposes them as ioBroker states ready to use in dashboards, scripts and automations.

> ⚠️ **EXPERIMENTAL — FOR PERSONAL TESTING ONLY**
>
> This adapter is an **unofficial, experimental proof of concept** intended solely for private testing of technical possibilities. It is **not** intended for production use.
>
> This adapter accesses the Cookidoo platform via an **unofficial, reverse-engineered API** that is **not publicly documented or approved by Vorwerk**. Using this adapter may violate the [Cookidoo Terms of Service](https://www.cookidoo.de/legal/terms). **Use entirely at your own risk.** The authors accept no liability for account suspensions, data loss, or any other consequences.
>
> This adapter is not affiliated with, endorsed by, or in any way connected to Vorwerk International & Co. KmG or any of its subsidiaries. Cookidoo® and Thermomix® are registered trademarks of Vorwerk. The API may stop working at any time without notice.

---

## Features

**Read (auto-polled):**
- Shopping list: recipes, ingredients with owned/missing status, additional free-text items
- Weekly meal calendar including today's recipes
- Personal recipe library ("Meine Rezepte" — saved and copied recipes)
- Recipe collections (Vorwerk managed + your own custom collections)
- Account and subscription information

**Write (action states):**
- Add/remove recipes from the shopping list by recipe ID
- Add/remove free-text additional items
- Clear the entire shopping list in one step
- Mark all ingredients as owned or missing
- Add/remove recipes in the weekly calendar by date
- Copy any Cookidoo recipe into your personal library by pasting its URL
- Delete recipes from your personal library
- Subscribe/unsubscribe Vorwerk collections
- Create/delete custom recipe collections

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

---

### `shopping`

All list states contain a **JSON array** that can be parsed in scripts or displayed in JSON widgets.

| State | Type | Description |
|---|---|---|
| `shopping.recipes` | JSON | Recipes on the shopping list — each entry has `id` (ULID), `name`, `ingredientsCount` |
| `shopping.recipesCount` | number | Number of recipes on the shopping list |
| `shopping.ingredientItems` | JSON | Ingredient items — each entry has `id`, `name`, `description`, `is_owned` |
| `shopping.ingredientItemsCount` | number | Total number of ingredient items |
| `shopping.unownedIngredientsCount` | number | Number of ingredients not yet marked as owned |
| `shopping.additionalItems` | JSON | Free-text items — each entry has `id`, `name`, `is_owned` |
| `shopping.additionalItemsCount` | number | Total number of additional items |
| `shopping.unownedAdditionalCount` | number | Number of additional items not yet owned |

**Example entries:**
```json
{ "id": "01JBS3P8KH...", "name": "Kokos Pralinen", "ingredientsCount": 3 }
{ "id": "01JBS24P4D...", "name": "Zucker", "description": "200 g", "is_owned": false }
{ "id": "01JBS3VW...",  "name": "Fleisch", "is_owned": false }
```

> **Note on recipe IDs:** `shopping.recipes[].id` is the internal shopping list ULID, not the original recipe ID (e.g. `r123456`). Use this ULID for `actions.removeRecipeFromShopping`. To add a recipe, use the original recipe ID (`r123456`).

---

### `calendar`

| State | Type | Description |
|---|---|---|
| `calendar.week` | JSON | Full week — array of days with `id` (YYYY-MM-DD), `title`, `recipes`, `customRecipeIds` |
| `calendar.todayRecipes` | JSON | Recipes planned for today only |

**Example `calendar.todayRecipes` entry:**
```json
{ "id": "r214846", "name": "Waffles", "totalTime": 1500 }
```

---

### `customRecipes`

Your personal recipe library — recipes you have saved or copied from Cookidoo.

| State | Type | Description |
|---|---|---|
| `customRecipes.list` | JSON | All saved recipes with `id`, `name`, `servingSize`, `totalTime`, `status`, `basedOn` |
| `customRecipes.count` | number | Number of saved recipes |

---

### `collections`

| State | Type | Description |
|---|---|---|
| `collections.managed` | JSON | Vorwerk-curated collections — each with `id`, `name`, `chapters[]` |
| `collections.managedCount` | number | Number of managed collections |
| `collections.custom` | JSON | Your own collections — each with `id`, `name`, `description`, `chapters[]` |
| `collections.customCount` | number | Number of custom collections |

---

### `actions`

#### Buttons — write `true` to trigger

| State | Description |
|---|---|
| `actions.refresh` | Immediately fetch fresh data from Cookidoo |
| `actions.clearShoppingList` | Remove all recipes and additional items from the shopping list |
| `actions.markAllOwned` | Mark all ingredient items on the shopping list as owned |
| `actions.markAllUnowned` | Reset all ingredient items to not owned |

#### Shopping list — write a value to trigger

| State | Value | Description |
|---|---|---|
| `actions.addRecipeToShopping` | Recipe ID, e.g. `r907015` | Add a recipe's ingredients to the shopping list |
| `actions.removeRecipeFromShopping` | ULID from `shopping.recipes[].id` | Remove a recipe from the shopping list |
| `actions.addAdditionalItem` | Item name as text, e.g. `Salz` | Add a free-text item to the shopping list |
| `actions.removeAdditionalItem` | ID from `shopping.additionalItems[].id` | Remove a free-text item |

#### Calendar — write a JSON string to trigger

| State | Value | Description |
|---|---|---|
| `actions.addRecipeToCalendar` | `{"date":"2026-04-13","recipeId":"r907015"}` | Plan a recipe on a specific day |
| `actions.removeRecipeFromCalendar` | `{"date":"2026-04-13","recipeId":"r907015"}` | Remove a recipe from a specific day |

#### Personal recipe library

| State | Value | Description |
|---|---|---|
| `actions.copyRecipeUrl` | Full Cookidoo URL | Copy a Cookidoo recipe into your personal library |
| `actions.deleteCustomRecipe` | ID from `customRecipes.list[].id` | Delete a recipe from your personal library |

> **How to copy a recipe:** Open any recipe on [cookidoo.de](https://cookidoo.de), copy the URL from the browser (e.g. `https://cookidoo.de/recipes/recipe/de-DE/r907015`) and write it to `actions.copyRecipeUrl`. The adapter will save a personal copy in your Cookidoo account under "Meine Rezepte".

#### Collections

| State | Value | Description |
|---|---|---|
| `actions.addManagedCollection` | Collection ID | Subscribe to a Vorwerk-curated collection |
| `actions.removeManagedCollection` | ID from `collections.managed[].id` | Unsubscribe from a managed collection |
| `actions.addCustomCollection` | Collection title as text | Create a new custom collection |
| `actions.removeCustomCollection` | ID from `collections.custom[].id` | Delete a custom collection |

---

## Example: Script automation

Send a notification when all ingredients are in stock:

```js
// JavaScript adapter
on({ id: 'cookidoo.0.shopping.unownedIngredientsCount', change: 'ne' }, obj => {
    if (obj.state.val === 0) {
        sendTo('telegram.0', 'Alle Zutaten vorhanden! Guten Appetit 🍽️');
    }
});
```

Add today's planned recipe to the shopping list automatically:

```js
on({ id: 'cookidoo.0.calendar.todayRecipes', change: 'any' }, obj => {
    const recipes = JSON.parse(obj.state.val || '[]');
    for (const recipe of recipes) {
        setState('cookidoo.0.actions.addRecipeToShopping', recipe.id);
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
* Initial release

---

## Credits

The API communication in this adapter is based on the research and implementation of the
**[cookidoo-api](https://github.com/miaucl/cookidoo-api)** Python package by
[Cyrill Raccaud (miaucl)](https://github.com/miaucl),
licensed under the MIT License.

The reverse-engineered Cookidoo API endpoints, authentication flow, request/response formats and
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
