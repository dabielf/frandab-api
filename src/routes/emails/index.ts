import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Resend } from "resend";
import testEmailTemplate from "../../lib/emails/test";
import googleEmailRouter from "./google-email-assistant";

const emailRouter = new Hono<{ Bindings: CloudflareBindings }>();

const emailSchema = z.object({
	email: z.string().email(),
	firstName: z.string().min(1),
	subject: z.string().min(1),
});

const validator = zValidator("json", emailSchema);

// Create email
emailRouter.post("/", validator, async (c) => {
	try {
		const resend = new Resend(c.env.RESEND_API_KEY);
		const { email, firstName, subject } = c.req.valid("json");

		const data = await resend.emails.send({
			from: "François <hello@frandab.com>",
			to: [email],
			subject,
			html: testEmailTemplate(firstName),
		});

		return c.json(data);
	} catch (error) {
		return c.json(
			{ error: "Internal server error", message: (error as Error).message },
			500,
		);
	}
});

emailRouter.route("/google", googleEmailRouter);

export default emailRouter;
