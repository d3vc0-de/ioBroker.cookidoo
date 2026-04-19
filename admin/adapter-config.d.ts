// This file extends the AdapterConfig type from "@types/iobroker"
// using the "native" property from io-package.json

export {};

declare global {
	namespace ioBroker {
		interface AdapterConfig {
			email: string;
			password: string;
			language: string;
			pollInterval: number;
			suppressConnectionErrors: boolean;
			enableShopping: boolean;
			enableCalendar: boolean;
			enableCustomRecipes: boolean;
			enableManagedCollections: boolean;
			enableCustomCollections: boolean;
		}
	}
}
