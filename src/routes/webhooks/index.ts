import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getDB } from "../../lib/server/db";
import { Webhook } from "svix";
import { users, apiKeys } from "../../lib/server/db/schema";
import { eq } from "drizzle-orm";

const webhooksRouter = new Hono<{ Bindings: CloudflareBindings }>();

export function generateApiKey(): string {
	return crypto.randomUUID();
}

webhooksRouter.post(
	"/",

	async (c) => {
		const db = getDB(c.env);
		const SIGNING_SECRET = c.env.SIGNING_SECRET;

		if (!SIGNING_SECRET) {
			throw new Error(
				"Error: Please add SIGNING_SECRET from Clerk Dashboard to .env",
			);
		}

		// Create new Svix instance with secret
		const wh = new Webhook(SIGNING_SECRET);

		// Get headers and body
		const payload = await c.req.json();
		const headers = c.req.header();

		// Get Svix headers for verification
		const svix_id = headers["svix-id"];
		const svix_timestamp = headers["svix-timestamp"];
		const svix_signature = headers["svix-signature"];

		// If there are no headers, error out
		if (!svix_id || !svix_timestamp || !svix_signature) {
			return c.json(
				{
					success: false,
					message: "Error: Missing svix headers",
				},
				400,
			);
		}

		let evt;

		// Attempt to verify the incoming webhook
		// If successful, the payload will be available from 'evt'
		// If verification fails, error out and return error code
		try {
			console.log({
				payload,
				svix_id,
				svix_timestamp,
				svix_signature,
			});
			evt = wh.verify(JSON.stringify(payload), {
				"svix-id": svix_id as string,
				"svix-timestamp": svix_timestamp as string,
				"svix-signature": svix_signature as string,
			});
		} catch (err) {
			console.log("Error: Could not verify webhook:", err.message);
			return c.json(
				{
					success: false,
					message: err.message,
				},
				400,
			);
		}

		// Do something with payload
		// For this guide, log payload to console
		const { id } = evt.data;
		const eventType = evt.type;
		console.log(
			`Received webhook with ID ${id} and event type of ${eventType}`,
		);
		console.log("Webhook payload:", evt.data);

		if (evt.type === "user.created") {
			const email = evt.data.email_addresses[0].email_address || "";
			const name = evt.data.first_name || "";
			const identityToken = evt.data.id || "";

			const existingUser = await db
				.select()
				.from(users)
				.where(eq(users.identityToken, identityToken))
				.limit(1)
				.single();

			if (existingUser) {
				return c.json(
					{
						success: true,
						message: "User connected",
					},
					200,
				);
			}

			const [user] = await db
				.insert(users)
				.values({ identityToken, email, name })
				.returning();

			const apiKey = generateApiKey();
			const [key] = await db
				.insert(apiKeys)
				.values({
					key: apiKey,
					userId: user.id,
				})
				.returning();
		}

		if (evt.type === "session.created") {
			console.log(evt.data);
		}

		return c.json(
			{
				success: true,
				message: "Webhook received",
			},
			200,
		);
	},
);

export default webhooksRouter;
