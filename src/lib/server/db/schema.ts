import { sql, relations } from "drizzle-orm";
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
		identityToken: text("identity_token").notNull(),
		encryptionKey: text("encryption_key").notNull(),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("email_idx").on(table.email),
		uniqueIndex("identity_token_idx").on(table.identityToken),
	],
);

export const usersRelations = relations(users, ({ one, many }) => ({
	settings: one(userSettings),
	contacts: many(contacts),
	apiKeys: many(apiKeys),
	emails: many(emails),
	notes: many(notes),
	projects: many(projects),
}));

export const userSettings = sqliteTable(
	"user_settings",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id").references(() => users.id),
		openAiApiKey: text("openai_api_key"),
		geminiApiKey: text("gemini_api_key"),
		resendApiKey: text("resend_api_key"),
		information: text("information"),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [index("user_settings_idx").on(table.userId)],
);

export const userSettingsRelations = relations(userSettings, ({ one }) => ({
	userId: one(users),
}));

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

export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
	userId: one(users),
}));

export const projects = sqliteTable(
	"projects",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		userId: integer("user_id").references(() => users.id),
		name: text("name").notNull(),
		description: text("description"),
		context: text("context"),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [index("project_user_id_idx").on(table.userId)],
);

export const projectsRelations = relations(projects, ({ one, many }) => ({
	userId: one(users),
	tasks: many(tasks),
}));

export const tasks = sqliteTable(
	"tasks",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		projectId: integer("project_id").references(() => projects.id),
		content: text("content").notNull(),
		completed: integer({ mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [index("task_project_id_idx").on(table.projectId)],
);

export const tasksRelations = relations(tasks, ({ one, many }) => ({
	projectId: one(projects),
	subtasks: many(subtasks),
}));

export const subtasks = sqliteTable(
	"subtasks",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		taskId: integer("task_id").references(() => tasks.id),
		content: text("content").notNull(),
		completed: integer({ mode: "boolean" }).notNull().default(false),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [index("subtask_task_id_idx").on(table.taskId)],
);

export const subtasksRelations = relations(subtasks, ({ one }) => ({
	taskId: one(tasks),
}));

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
		context: text("context"),
		createdAt: text("created_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at").notNull().default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("phone_idx").on(table.phone),
		index("contact_user_id_idx").on(table.userId),
	],
);

export const contactsRelations = relations(contacts, ({ one, many }) => ({
	userId: one(users),
	notes: many(notes),
}));

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

export const notesRelations = relations(notes, ({ one }) => ({
	userId: one(users),
	contact: one(contacts),
}));

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

export const emailsRelations = relations(emails, ({ one }) => ({
	userId: one(users),
}));
