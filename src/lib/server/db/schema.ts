import { sql } from "drizzle-orm";
import {
	sqliteTable,
	text,
	integer,
	index,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
	"users",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		email: text("email").notNull().unique(),
		name: text("name"),
		// Use 'free' by default; switch to 'paid' when the user subscribes.

		// Timestamps stored as text; you can also use a proper timestamp type if available.
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [uniqueIndex("email_idx").on(table.email)],
);

export const apiKeys = sqliteTable(
	"api_keys",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id").references(() => users.id),
		key: text("key").notNull().unique(),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("key_idx").on(table.key),
		index("user_id_idx").on(table.userId),
	],
);

export const emails = sqliteTable("emails", {
	id: integer("id").primaryKey({ autoIncrement: true }),
	userId: integer("user_id").references(() => users.id),
	fromAddress: text("from_address").notNull(),
	toAddress: text("to_address").notNull(),
	subject: text("subject").notNull(),
	body: text("body").notNull(),
	// Timestamps stored as text; you can also use a proper timestamp type if available.
	createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
});
