import { drizzle } from "drizzle-orm/d1";

let db: ReturnType<typeof drizzle>;

export function getDB(env: CloudflareBindings) {
	if (!db) {
		db = drizzle(env.DB);
	}
	return db;
}
