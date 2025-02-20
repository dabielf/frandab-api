// user routes

import { type Context, Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDB } from "../../lib/server/db";
import { users, userSettings } from "../../lib/server/db/schema";
import { eq } from "drizzle-orm";

const userRouter = new Hono<{ Bindings: CloudflareBindings }>();

// Schema for user creation and update
const userSchema = z.object({
	email: z.string().email(),
	name: z.string().min(1),
});

// Generate a secure API key
export function generateApiKey(): string {
	return crypto.randomUUID();
}

export type UserSettings = {
	userId: number;
	openAiApiKey: string | null;
	geminiApiKey: string | null;
	resendApiKey: string | null;
	information: string | null;
};

export type User = {
	id: number;
	email: string;
	name: string | null;
	identityToken: string;
	encryptionKey: string;
	error: string | null;
	settings: UserSettings | null;
};

export type ErrorMessage = {
	error: string;
	message?: string;
};

export async function getUser(c: Context): Promise<User | ErrorMessage> {
	const db = getDB(c.env);
	const userId = c.req.header("User-Id");
	if (!userId) {
		return { error: "User not found" };
	}

	try {
		const response = await db
			.select()
			.from(users)
			.where(eq(users.identityToken, userId))
			.leftJoin(userSettings, eq(userSettings.userId, users.id));

		if (response.length === 0) {
			return { error: "User not found" };
		}

		const userData = {
			...response[0].users,
			settings: response[0].user_settings,
		};

		return {
			...userData,
			error: null,
		};
	} catch (error) {
		return { error: "User not found" };
	}
}

export const validator = zValidator("json", userSchema);

// Get all users
userRouter.get("/", async (c) => {
	console.log("GET /api/users called:");
	try {
		const db = getDB(c.env);
		const userList = await db.select().from(users);
		console.log({ userList });
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

// userRouter.post("/:id/settings/google-api-key", validator, async (c) => {
// 	try {
// 		const db = getDB(c.env);
// 		const id = Number(c.req.param("id"));

// });

export default userRouter;
