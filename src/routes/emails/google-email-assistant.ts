import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import { Resend } from "resend";

const googleEmailRouter = new Hono<{ Bindings: CloudflareBindings }>();

const googleEmailSchema = z.object({
	email: z.string().email(),
	fromName: z.string().min(1).optional(),
	instructions: z.string().min(1),
	language: z.string().min(1).optional(),
	gender: z.string().min(1).optional(),
});

const googleValidator = zValidator("json", googleEmailSchema);

function emailPromptBase(
	instructions: string,
	fromName = "François",
	gender = "male",
	language = "english",
) {
	return `You are an AI that is responsible for generating emails. You will be given a subject and a content title and content body. You will generate an email, in ${language} from ${fromName}, whose gender is ${gender} based on the the following instructions: ${instructions} The email should be in HTML format. Make sure it's pure HTML, no markdown. The email should be short and concise. The email should be in the following format: <div>Content Body</div>`;
}

googleEmailRouter.post("/", googleValidator, async (c) => {
	try {
		const google = createGoogleGenerativeAI({
			apiKey: c.env.GOOGLE_GENERATIVE_AI_API_KEY,
		});
		const resend = new Resend(c.env.RESEND_API_KEY);
		const { email, fromName, instructions, language, gender } =
			c.req.valid("json");

		const {
			object: { subject, htmlContent },
		} = await generateObject({
			model: google("gemini-2.0-flash-exp", {
				useSearchGrounding: true,
			}),
			schema: z.object({
				subject: z.string().min(1),
				htmlContent: z.string().min(1),
			}),
			prompt: emailPromptBase(instructions, fromName, gender, language),
		});

		const data = await resend.emails.send({
			from: `${fromName || "François"} <hello@frandab.com>`,
			to: [email],
			subject,
			html: htmlContent,
		});
		return c.json(data);
	} catch (error) {
		return c.json(
			{ error: "Internal server error", message: (error as Error).message },
			500,
		);
	}
});

export default googleEmailRouter;
