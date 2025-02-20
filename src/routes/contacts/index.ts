import { type Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDB } from "../../lib/server/db";
import { contacts, notes } from "../../lib/server/db/schema";
import { getUser } from "../users";
import { eq, and } from "drizzle-orm";

const contactsRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Schema for contact creation and update
const contactSchema = z.object({
	userId: z.string(),
	name: z.string().min(1),
	email: z.string().email().optional(),
	phone: z.string().optional(),
	profession: z.string().optional(),
	interests: z.string().optional(),
});

// Schema for notes
const noteSchema = z.object({
	userId: z.string(),
	contactId: z.string(),
	title: z.string().optional(),
	content: z.string().min(1),
});

// Validators
const contactValidator = zValidator("json", contactSchema);
const noteValidator = zValidator("json", noteSchema);

// Create contact
contactsRouter.post("/", contactValidator, async (c) => {
	try {
		const contactData = c.req.valid("json");
		const db = getDB(c.env);
		const user = await getUser(c);
		if (user.error) {
			return c.json({ error: "User not found" }, 404);
		}

		const [contact] = await db
			.insert(contacts)
			.values({
				...contactData,
				userId: Number(user.id),
			})
			.returning();

		return c.json({ contact }, 201);
	} catch (error) {
		return c.json({ error: "Failed to create contact" }, 500);
	}
});

// Get all contacts
contactsRouter.get("/", async (c) => {
	try {
		const db = getDB(c.env);

		const user = await getUser(c);
		if (!user) {
			return c.json({ error: "User not found" }, 404);
		}

		try {
			const contactList = await db
				.select()
				.from(contacts)
				.where(eq(contacts.userId, user.id));

			return c.json({ contacts: contactList || [] }, 200);
		} catch (error) {
			console.error({ error });
			return c.json(
				{
					error: "Failed to fetch contacts",
					message: (error as Error).message,
				},
				500,
			);
		}
	} catch (error) {
		console.error({ error });
		return c.json(
			{
				error: "Failed to fetch contacts",
				message: (error as Error).message,
			},
			500,
		);
	}
});

// Get single contact with notes
contactsRouter.get("/:id", async (c) => {
	try {
		const db = getDB(c.env);
		const userId = c.req.header("User-Id");
		const contactId = Number.parseInt(c.req.param("id"));

		if (!contactId) {
			return c.json({ error: "Contact not found" }, 404);
		}

		if (!userId) {
			return c.json({ error: "User not found" }, 404);
		}

		const contact = await db
			.select()
			.from(contacts)
			.where(
				and(
					eq(contacts.id, contactId),
					eq(contacts.userId, Number.parseInt(userId || "0")),
				),
			)
			.limit(1);

		if (!contact.length) {
			return c.json({ error: "Contact not found" }, 404);
		}

		const contactNotes = await db
			.select()
			.from(notes)
			.where(and(eq(notes.contactId, contactId), eq(notes.userId, userId)));

		return c.json({
			contact: contact[0],
			notes: contactNotes,
		});
	} catch (error) {
		return c.json({ error: "Failed to fetch contact" }, 500);
	}
});

// Update contact
contactsRouter.put("/:id", contactValidator, async (c) => {
	try {
		const contactData = c.req.valid("json");
		const db = getDB(c.env);
		const userId = c.req.header("User-Id");
		const contactId = Number.parseInt(c.req.param("id"));

		if (!contactId) {
			return c.json({ error: "Contact not found" }, 404);
		}

		if (!userId) {
			return c.json({ error: "User not found" }, 404);
		}

		const [updated] = await db
			.update(contacts)
			.set({
				...contactData,
				updatedAt: new Date().toISOString(),
			})
			.where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
			.returning();

		if (!updated) {
			return c.json({ error: "Contact not found" }, 404);
		}

		return c.json({ contact: updated });
	} catch (error) {
		return c.json({ error: "Failed to update contact" }, 500);
	}
});

// Delete contact
contactsRouter.delete("/:id", async (c) => {
	try {
		const db = getDB(c.env);
		const userId = c.req.header("User-Id");
		const contactId = Number.parseInt(c.req.param("id"));

		if (!contactId) {
			return c.json({ error: "Contact not found" }, 404);
		}

		if (!userId) {
			return c.json({ error: "User not found" }, 404);
		}

		// Delete associated notes first
		await db
			.delete(notes)
			.where(
				and(
					eq(notes.contactId, contactId),
					eq(notes.userId, Number.parseInt(userId || "0")),
				),
			);

		const [deleted] = await db
			.delete(contacts)
			.where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)))
			.returning();

		if (!deleted) {
			return c.json({ error: "Contact not found" }, 404);
		}

		return c.json({ message: "Contact deleted successfully" });
	} catch (error) {
		return c.json({ error: "Failed to delete contact" }, 500);
	}
});

// Add note to contact
contactsRouter.post("/:id/notes", noteValidator, async (c) => {
	try {
		const noteData = c.req.valid("json");
		const db = getDB(c.env);
		const userId = c.req.header("User-Id");
		const contactId = Number.parseInt(c.req.param("id"));

		if (!contactId) {
			return c.json({ error: "Contact not found" }, 404);
		}

		if (!userId) {
			return c.json({ error: "User not found" }, 404);
		}

		// Verify contact exists and belongs to user
		const contact = await db
			.select()
			.from(contacts)
			.where(
				and(
					eq(contacts.id, contactId),
					eq(contacts.userId, Number.parseInt(userId || "0")),
				),
			)
			.limit(1);

		if (!contact.length) {
			return c.json({ error: "Contact not found" }, 404);
		}

		const [note] = await db
			.insert(notes)
			.values({
				...noteData,
				userId: Number.parseInt(userId || "0"),
				contactId,
			})
			.returning();

		return c.json({ note }, 201);
	} catch (error) {
		return c.json({ error: "Failed to add note" }, 500);
	}
});

// Delete note
contactsRouter.delete("/:contactId/notes/:noteId", async (c) => {
	try {
		const db = getDB(c.env);
		const userId = c.get("userId");
		const contactId = parseInt(c.req.param("contactId"));
		const noteId = parseInt(c.req.param("noteId"));

		const [deleted] = await db
			.delete(notes)
			.where(
				and(
					eq(notes.id, noteId),
					eq(notes.contactId, contactId),
					eq(notes.userId, userId),
				),
			)
			.returning();

		if (!deleted) {
			return c.json({ error: "Note not found" }, 404);
		}

		return c.json({ message: "Note deleted successfully" });
	} catch (error) {
		return c.json({ error: "Failed to delete note" }, 500);
	}
});

export default contactsRouter;
