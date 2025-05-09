import { Hono } from "hono";
import { cors } from "hono/cors";
import userRouter, { validator, generateApiKey } from "./routes/users";
import emailRouter from "./routes/emails";
import webhooksRouter from "./routes/webhooks";
import contactsRouter from "./routes/contacts";
import gmailRouter from "./routes/gmail";
import { bearerAuth } from "hono/bearer-auth";
import { users, apiKeys } from "./lib/server/db/schema";
import { eq } from "drizzle-orm";
import { getDB } from "./lib/server/db";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.use(cors());
// Mount webhook routes under /webhooks
app.route("/webhooks", webhooksRouter);

app.get("/", (c) => {
	return c.text("Hello Frandab updated!");
});

// app.post("/init-admin", validator, async (c) => {
// 	try {
// 		const { email, name } = c.req.valid("json");
// 		const db = getDB(c.env);

// 		// Start a transaction to create both user and API key

// 		const [user] = await db.insert(users).values({ email, name }).returning();

// 		const apiKey = generateApiKey();
// 		const [key] = await db
// 			.insert(apiKeys)
// 			.values({
// 				userId: user.id,
// 				key: apiKey,
// 			})
// 			.returning();

// 		return c.json({ user, apiKey: key.key }, 201);
// 	} catch (error) {
// 		if ((error as Error).message.includes("UNIQUE constraint failed")) {
// 			return c.json({ error: "Email already exists" }, 409);
// 		}
// 		return c.json(
// 			{ error: "Internal server error", message: (error as Error).message },
// 			500,
// 		);
// 	}
// });

// app.use(
// 	"/api/*",
// 	bearerAuth({
// 		verifyToken: async (token, c) => {
// 			const db = getDB(c.env);
// 			console.log({ token });
// 			const user = await db
// 				.select()
// 				.from(apiKeys)
// 				.where(eq(apiKeys.key, token));

// 			return user.length > 0;
// 		},
// 	}),
// );

app.get("/api", (c) => {
	return c.text("Hello François, welcome to your API updated!");
});

// Mount user routes under /users
app.route("/api/users", userRouter);

// Mount email routes under /emails
app.route("/api/emails", emailRouter);

// Mount contact routes under /contacts
app.route("/api/contacts", contactsRouter);

// Mount gmail routes under /gmail
app.route("/api/gmail", gmailRouter);

export default app;
