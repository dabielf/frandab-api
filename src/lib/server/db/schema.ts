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
		identityToken: text("identity_token"),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("email_idx").on(table.email),
		uniqueIndex("identity_token_idx").on(table.identityToken),
	],
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
		index("api_key_idx").on(table.key),
		index("api_user_id_idx").on(table.userId),
	],
);

export const contacts = sqliteTable(
	"contacts",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id").references(() => users.id),
		name: text("name").notNull(),
		email: text("email"),
		phone: text("phone"),
		profession: text("profession"),
		interests: text("interests"),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("phone_idx").on(table.phone),
		index("contact_user_id_idx").on(table.userId),
	],
);

export const notes = sqliteTable(
	"notes",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id").references(() => users.id),
		contactId: integer("contact_id")
			.notNull()
			.references(() => contacts.id),
		title: text("title"),
		content: text("content").notNull(),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [index("user_contact_id_idx").on(table.userId, table.contactId)],
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
