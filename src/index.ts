import { Hono } from "hono";
import userRouter from "./routes/users";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/", (c) => {
	return c.text("Hello François, welcome to your API!");
});

// Mount user routes under /users
app.route("/users", userRouter);

export default app;
