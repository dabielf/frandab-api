import { Hono } from "hono";
import userRouter from "./routes/users";
import { bearerAuth } from "hono/bearer-auth";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/api", (c) => {
	return c.text("Hello François, welcome to your API!");
});

// Mount user routes under /users
app.route("/api/users", userRouter);

// app.use(
// 	"/auth-verify-token/*",
// 	bearerAuth({
// 		verifyToken: async (token, c) => {
// 			return token === "dynamic-token";
// 		},
// 	}),
// );

export default app;
