// user routes

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDB } from "../../lib/server/db";
import { users, apiKeys } from "../../lib/server/db/schema";
import { eq } from "drizzle-orm";

const userRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Schema for user creation and update
const userSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1),
});

// Generate a secure API key
function generateApiKey(): string {
	return crypto.randomUUID();
}

// Create user
userRouter.post("/", zValidator("json", userSchema), async (c) => {
	try {
		const { email, name } = c.req.valid("json");
		const db = getDB(c.env);

		// Start a transaction to create both user and API key
		const result = await db.transaction(async (tx) => {
			const [user] = await tx.insert(users).values({ email, name }).returning();

			const apiKey = generateApiKey();
			const [key] = await tx
				.insert(apiKeys)
				.values({
					userId: user.id,
					key: apiKey,
				})
				.returning();

			return { user, apiKey: key.key };
		});

		return c.json(result, 201);
	} catch (error) {
		if ((error as Error).message.includes("UNIQUE constraint failed")) {
			return c.json({ error: "Email already exists" }, 409);
		}
		return c.json({ error: "Internal server error" }, 500);
	}
});

// Get all users
userRouter.get("/", async (c) => {
	try {
		const db = getDB(c.env);
		const userList = await db.select().from(users);
		return c.json({ users: userList });
	} catch (error) {
		return c.json({ error: "Internal server error" }, 500);
	}
});

// Get user by id
userRouter.get("/:id", async (c) => {
	try {
		const db = getDB(c.env);
		const id = Number(c.req.param("id"));
		const [user] = await db.select().from(users).where(eq(users.id, id));

		if (!user) {
			return c.json({ error: "User not found" }, 404);
		}

		return c.json({ user });
	} catch (error) {
		return c.json({ error: "Internal server error" }, 500);
	}
});

// Update user
userRouter.put("/:id", zValidator("json", userSchema), async (c) => {
	try {
		const db = getDB(c.env);
		const id = Number(c.req.param("id"));
		const { email, name } = c.req.valid("json");

		const [updatedUser] = await db
			.update(users)
			.set({
				email,
				name,
				updatedAt: new Date().toISOString(),
			})
			.where(eq(users.id, id))
			.returning();

		if (!updatedUser) {
			return c.json({ error: "User not found" }, 404);
		}

		return c.json({ user: updatedUser });
	} catch (error) {
		if ((error as Error).message.includes("UNIQUE constraint failed")) {
			return c.json({ error: "Email already exists" }, 409);
		}
		return c.json({ error: "Internal server error" }, 500);
	}
});

// Delete user
userRouter.delete("/:id", async (c) => {
	try {
		const db = getDB(c.env);
		const id = Number(c.req.param("id"));

		const [deletedUser] = await db
			.delete(users)
			.where(eq(users.id, id))
			.returning();

		if (!deletedUser) {
			return c.json({ error: "User not found" }, 404);
		}

		return c.json({ message: "User deleted successfully" });
	} catch (error) {
		return c.json({ error: "Internal server error" }, 500);
	}
});

export default userRouter;
