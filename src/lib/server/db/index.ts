import { drizzle } from "drizzle-orm/d1";
import { getPlatformProxy } from "wrangler";

const { env } = await getPlatformProxy();
export const db = drizzle(env.DB as D1Database);
