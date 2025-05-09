import { Hono, type Context } from "hono";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import type { gmail_v1 } from "@googleapis/gmail";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { z } from "zod";

// --- Type Definitions ---
interface EmailHeader {
	name: string;
	value: string;
}

interface Email {
	id: string;
	messageId: string;
	threadId: string;
	subject: string;
	from: string;
	to: string[];
	cc: string[];
	receivedDateTime: string;
	body: string;
	snippet: string;
	headers: EmailHeader[];
}

interface FetchedEmail extends Email {}

interface SentEmail {
	id: string;
	subject: string;
	recipients: string[];
	sentDateTime: string;
}

const AiEmailAnalysisSchema = z.object({
	emailId: z
		.string()
		.describe(
			"The unique ID of the email that was analyzed (must match the 'id' field from the input email).",
		),
	importance: z
		.enum(["high", "medium", "low"])
		.describe("The assessed importance of the email."),
	reason: z
		.string()
		.describe(
			"A brief explanation for the assessed importance and identified topics.",
		),
	needs_response: z
		.boolean()
		.describe(
			"True if the email explicitly or implicitly requires a response, false otherwise.",
		),
	time_sensitive: z
		.boolean()
		.describe(
			"True if the email content suggests a deadline or urgency, false otherwise.",
		),
	topics: z
		.array(z.string())
		.describe("A list of 2-5 main topics or keywords identified in the email."),
});
type AiEmailAnalysis = z.infer<typeof AiEmailAnalysisSchema>;

interface AnalyzedEmail extends FetchedEmail {
	analysis: AiEmailAnalysis;
	already_responded: boolean;
}

interface DisplayAnalyzedEmail {
	id: string;
	from: string;
	subject: string;
	importance: "high" | "medium" | "low";
	reason: string;
	needs_response: boolean;
	time_sensitive: boolean;
	topics: string[];
}

interface NeedsResponseOutput {
	last_updated: string;
	needs_response_emails: AnalyzedEmail[];
	report: string;
	analyzed_emails: DisplayAnalyzedEmail[];
}

// Define a more specific error type for Google API errors
interface GApiError extends Error {
	code?: number;
	errors?: Array<{ message: string; domain: string; reason: string }>;
}

// Environment variable typings for Hono context
interface Env {
	Bindings: {
		GOOGLE_GENERATIVE_AI_API_KEY: string;
		GOOGLE_CLIENT_ID: string;
		GOOGLE_CLIENT_SECRET: string;
		GOOGLE_REFRESH_TOKEN: string;
	};
}

const app = new Hono<Env>();

// --- Helper Functions ---
function getOAuth2Client(c: Context<Env>): OAuth2Client {
	const oauth2Client = new google.auth.OAuth2(
		c.env.GOOGLE_CLIENT_ID,
		c.env.GOOGLE_CLIENT_SECRET,
	);
	oauth2Client.setCredentials({ refresh_token: c.env.GOOGLE_REFRESH_TOKEN });
	return oauth2Client;
}

async function getEmailsFromGmail(
	gmail: gmail_v1.Gmail,
	hours = 24,
): Promise<FetchedEmail[]> {
	const afterDate = new Date();
	afterDate.setHours(afterDate.getHours() - hours);
	const query = `is:unread in:inbox after:${Math.floor(afterDate.getTime() / 1000)}`;

	try {
		const res = await gmail.users.messages.list({
			userId: "me",
			q: query,
			maxResults: 50, // Adjust as needed
		});

		const messages = res.data.messages;
		if (!messages || messages.length === 0) {
			console.log("No new messages found.");
			return [];
		}

		const emails: FetchedEmail[] = [];
		for (const message of messages) {
			if (!message.id) continue;
			const msg = await gmail.users.messages.get({
				userId: "me",
				id: message.id,
				format: "full",
			});

			const subjectHeader = msg.data.payload?.headers?.find(
				(h: gmail_v1.Schema$MessagePartHeader) => h.name === "Subject",
			);
			const fromHeader = msg.data.payload?.headers?.find(
				(h: gmail_v1.Schema$MessagePartHeader) => h.name === "From",
			);
			const dateHeader = msg.data.payload?.headers?.find(
				(h: gmail_v1.Schema$MessagePartHeader) => h.name === "Date",
			);

			let body = "";
			if (msg.data.payload?.parts) {
				for (const part of msg.data.payload.parts) {
					if (part.mimeType === "text/plain" && part.body?.data) {
						body = Buffer.from(part.body.data, "base64").toString("utf-8");
						break;
					}
				}
				// Fallback to html if no plain text
				if (!body) {
					for (const part of msg.data.payload.parts) {
						if (part.mimeType === "text/html" && part.body?.data) {
							body = Buffer.from(part.body.data, "base64").toString("utf-8");
							// Basic HTML to text conversion (consider a library for complex HTML)
							body = body
								.replace(/<[^>]*>/g, " ")
								.replace(/\s+/g, " ")
								.trim();
							break;
						}
					}
				}
			} else if (msg.data.payload?.body?.data) {
				body = Buffer.from(msg.data.payload.body.data, "base64").toString(
					"utf-8",
				);
				if (msg.data.payload.mimeType === "text/html") {
					body = body
						.replace(/<[^>]*>/g, " ")
						.replace(/\s+/g, " ")
						.trim();
				}
			}

			if (msg.data.id && msg.data.threadId) {
				// Ensure id and threadId are present
				emails.push({
					id: msg.data.id,
					messageId:
						msg.data.payload?.headers?.find(
							(h: gmail_v1.Schema$MessagePartHeader) => h.name === "Message-ID",
						)?.value || "",
					threadId: msg.data.threadId,
					subject: subjectHeader?.value || "No Subject",
					from: fromHeader?.value || "Unknown Sender",
					to: [],
					cc: [],
					receivedDateTime: dateHeader?.value
						? new Date(dateHeader.value).toISOString()
						: new Date().toISOString(),
					body: body.trim(),
					snippet: msg.data.snippet || "",
					headers: (msg.data.payload?.headers || [])
						.filter(
							(
								h,
							): h is gmail_v1.Schema$MessagePartHeader & {
								name: string;
								value: string;
							} => typeof h.name === "string" && typeof h.value === "string",
						)
						.map((h) => ({ name: h.name, value: h.value })),
				});
			}
		}
		return emails;
	} catch (error) {
		console.error("Error fetching emails:", error);
		throw new Error("Failed to fetch emails from Gmail.");
	}
}

async function getSentEmailsFromGmail(
	gmail: gmail_v1.Gmail,
	days = 7,
): Promise<SentEmail[]> {
	const afterDate = new Date();
	afterDate.setDate(afterDate.getDate() - days);
	const query = `in:sent after:${afterDate.toISOString().split("T")[0]}`;

	try {
		const res = await gmail.users.messages.list({
			userId: "me",
			q: query,
			maxResults: 100, // Adjust as needed
		});

		const messages = res.data.messages;
		if (!messages || messages.length === 0) {
			return [];
		}

		const sentEmails: SentEmail[] = [];
		for (const message of messages) {
			if (!message.id) continue;
			const msg = await gmail.users.messages.get({
				userId: "me",
				id: message.id,
				format: "metadata", // We only need headers
				metadataHeaders: ["Subject", "To", "Date"],
			});

			const subject =
				msg.data.payload?.headers?.find(
					(h: gmail_v1.Schema$MessagePartHeader) => h.name === "Subject",
				)?.value || "";
			const toHeader =
				msg.data.payload?.headers?.find(
					(h: gmail_v1.Schema$MessagePartHeader) => h.name === "To",
				)?.value || "";
			const recipients = (toHeader || "")
				.split(",")
				.map((email: string) => email.match(/<([^>]+)>/)?.[1] || email.trim())
				.filter((e: string | null | undefined) => e);
			const sentDateTime =
				msg.data.payload?.headers?.find(
					(h: gmail_v1.Schema$MessagePartHeader) => h.name === "Date",
				)?.value || new Date().toISOString();

			if (msg.data.id) {
				// Ensure id is present
				sentEmails.push({
					id: msg.data.id,
					subject: subject,
					recipients: recipients.map((r: string) => r.toLowerCase()),
					sentDateTime: new Date(sentDateTime).toISOString(),
				});
			}
		}
		return sentEmails;
	} catch (error) {
		console.error("Error fetching sent emails:", error);
		throw new Error("Failed to fetch sent emails from Gmail.");
	}
}

function isPreviouslyResponded(email: Email, sentEmails: SentEmail[]): boolean {
	const fromMatch = email.from.match(/<(.+?)>/);
	const senderEmail = fromMatch
		? fromMatch[1].toLowerCase()
		: email.from.toLowerCase();

	if (!senderEmail) return false;

	const cleanEmailSubject = (email.subject || "")
		.toLowerCase()
		.replace(/^(?:re|fwd):\s*/i, "");

	for (const sentEmail of sentEmails) {
		if (sentEmail.recipients.includes(senderEmail)) {
			const cleanSentSubject = (sentEmail.subject || "")
				.toLowerCase()
				.replace(/^(?:re|fwd):\s*/i, "");
			if (
				cleanEmailSubject === cleanSentSubject ||
				cleanEmailSubject.includes(cleanSentSubject) ||
				cleanSentSubject.includes(cleanEmailSubject)
			) {
				return true;
			}
		}
	}
	return false;
}

interface EmailInputForAI {
	id: string;
	from: string;
	subject: string;
	bodySnippet: string;
}

async function analyzeBatchEmailImportanceWithAISDK(
	c: Context<Env>,
	emails: Email[],
): Promise<AiEmailAnalysis[]> {
	if (!emails || emails.length === 0) {
		return [];
	}

	const aiApiKey = c.env.GOOGLE_GENERATIVE_AI_API_KEY;
	if (!aiApiKey) {
		console.error("GOOGLE_GENERATIVE_AI_API_KEY is not set.");
		throw new Error(
			"Configuration error: GOOGLE_GENERATIVE_AI_API_KEY is not set. AI analysis cannot proceed.",
		);
	}
	// Use the Vercel AI SDK's google provider
	const genAIProvider = createGoogleGenerativeAI({
		apiKey: aiApiKey,
	});

	const emailInputsForPrompt: EmailInputForAI[] = emails.map((email) => ({
		id: email.id, // Crucial for matching results back
		from: email.from,
		subject: email.subject,
		// Truncate body to manage overall prompt size, e.g., first 2000 chars
		bodySnippet: `${email.body.substring(0, 2000)}${email.body.length > 2000 ? "..." : ""}`,
	}));

	const systemPrompt = `You are an expert email analysis assistant.
  You will be provided with a batch of emails. For each email, analyze its content and determine:
  1.  **emailId**: The original ID of the email (must match the 'id' field from the input email for that email).
  2.  **importance**: (high, medium, or low) - Assess based on sender, content, and potential impact.
  3.  **reason**: A concise explanation for the importance rating and identified topics.
  4.  **needs_response**: (true or false) - Does it require a reply?
  5.  **time_sensitive**: (true or false) - Are there deadlines or urgent matters?
  6.  **topics**: An array of 2-5 main topics/keywords.
  
  Respond with a JSON array, where each object in the array corresponds to one email and strictly follows the provided schema. Ensure every email in the input batch has a corresponding analysis object in your output array, matched by its original emailId.`;

	let userPrompt =
		"Analyze the following batch of emails. Ensure each email analysis in your response includes the correct 'emailId' matching the input email ID:\n\n";
	emailInputsForPrompt.forEach((emailInput, index) => {
		userPrompt += `--- Email ${index + 1} ---\n`;
		userPrompt += `ID: ${emailInput.id}\n`; // Make sure AI uses this ID
		userPrompt += `From: ${emailInput.from}\n`;
		userPrompt += `Subject: ${emailInput.subject}\n`;
		userPrompt += `Body Snippet: ${emailInput.bodySnippet}\n\n`;
	});

	try {
		console.log(
			`Sending ${emailInputsForPrompt.length} emails to AI for batch analysis...`,
		);
		// The 'googleAiSdk' was imported as 'google' aliased. Let's use the Vercel SDK convention directly.
		// The model should be from the provider instance, e.g., genAIProvider('model-name')
		const { object: analysisResults } = await generateObject({
			model: genAIProvider("gemini-2.5-flash-preview-04-17"), // User changed this model
			schema: AiEmailAnalysisSchema,
			output: "array",
			system: systemPrompt,
			prompt: userPrompt,
		});
		console.log(
			"Batch AI analysis successful. Results count: ",
			(analysisResults as AiEmailAnalysis[]).length,
		);
		return analysisResults as AiEmailAnalysis[];
	} catch (error) {
		console.error("Error during batch AI email analysis:", error);
		let errorMessage = "AI generation failed.";
		if (error instanceof Error) {
			errorMessage = `AI generation failed: ${error.message}`;
			if (error.cause) {
				console.error("Cause:", error.cause);
				// If cause is also an Error, append its message
				if (error.cause instanceof Error) {
					errorMessage += ` Caused by: ${error.cause.message}`;
				}
			}
		}
		throw new Error(errorMessage, {
			cause: error instanceof Error ? error.cause : error,
		});
	}
}

// --- Hono Routes ---
app.get("/analyze-emails", async (c: Context<Env>) => {
	try {
		const oauth2Client = getOAuth2Client(c);
		const gmail = google.gmail({ version: "v1", auth: oauth2Client });

		console.log("Fetching emails from the last 24 hours...");
		const fetchedEmails = await getEmailsFromGmail(gmail, 24); // Expects to return Email[]

		if (fetchedEmails.length === 0) {
			console.log("No emails fetched to analyze.");
			return c.json({
				last_updated: new Date().toISOString(),
				needs_response_emails: [],
				report: "No emails fetched to analyze.",
				analyzed_emails: [],
			});
		}

		console.log(
			`Fetched ${fetchedEmails.length} emails. Starting batch analysis...`,
		);

		// Call the new batch analysis function
		const batchAnalysisResults = await analyzeBatchEmailImportanceWithAISDK(
			c,
			fetchedEmails,
		);

		console.log(
			`Finished batch analysis. Received ${batchAnalysisResults.length} results from AI.`,
		);

		console.log("Checking sent folder for previous responses (last 7 days)...");
		const sentEmails = await getSentEmailsFromGmail(gmail, 7);

		const needsResponseEmails: AnalyzedEmail[] = [];
		const displayAnalyzedEmails: DisplayAnalyzedEmail[] = [];

		// Create a map for efficient lookup of original emails by ID
		const fetchedEmailsMap = new Map(
			fetchedEmails.map((email) => [email.id, email]),
		);

		// Process the batch results
		for (const analysis of batchAnalysisResults) {
			const originalEmail = fetchedEmailsMap.get(analysis.emailId);

			if (originalEmail) {
				displayAnalyzedEmails.push({
					id: originalEmail.id,
					from: originalEmail.from,
					subject: originalEmail.subject,
					importance: analysis.importance,
					reason: analysis.reason,
					needs_response: analysis.needs_response,
					time_sensitive: analysis.time_sensitive,
					topics: analysis.topics,
				});

				if (analysis.needs_response) {
					const alreadyResponded = isPreviouslyResponded(
						originalEmail,
						sentEmails,
					);
					needsResponseEmails.push({
						// Ensure all fields from FetchedEmail/Email are here
						id: originalEmail.id,
						messageId: originalEmail.messageId,
						threadId: originalEmail.threadId,
						from: originalEmail.from,
						to: originalEmail.to,
						cc: originalEmail.cc,
						subject: originalEmail.subject,
						body: `${originalEmail.body.substring(0, 1000)}${originalEmail.body.length > 1000 ? "..." : ""}`,
						snippet: originalEmail.snippet,
						receivedDateTime: originalEmail.receivedDateTime,
						headers: originalEmail.headers,
						analysis: analysis, // This is AiEmailAnalysis type
						already_responded: alreadyResponded,
					});
				}
			} else {
				// This case means the AI returned an analysis for an emailId not in our fetched batch
				// Or the emailId in the AI response was garbled/incorrect.
				console.warn(
					`AI returned analysis for an unknown/unmatched emailId: ${analysis.emailId}. AI reason: ${analysis.reason}`,
				);
				// Optionally create a display item for this orphaned analysis if desired for debugging
				displayAnalyzedEmails.push({
					id: analysis.emailId,
					from: "Unknown (AI Mismatch)",
					subject: "Unknown (AI Mismatch)",
					importance: analysis.importance,
					reason: `${analysis.reason} (Original email not found for this ID in fetched batch)`,
					needs_response: analysis.needs_response,
					time_sensitive: analysis.time_sensitive,
					topics: analysis.topics,
				});
			}
		}

		// Sort emails (logic remains the same, but uses `analysis` from `needsResponseEmails` items)
		const sortedEmails = [...needsResponseEmails].sort((a, b) => {
			if (a.already_responded !== b.already_responded) {
				return a.already_responded ? 1 : -1;
			}
			// Ensure 'analysis' object exists before accessing its properties
			const aTimeSensitive = a.analysis?.time_sensitive ?? false;
			const bTimeSensitive = b.analysis?.time_sensitive ?? false;
			if (aTimeSensitive !== bTimeSensitive) {
				return aTimeSensitive ? -1 : 1;
			}
			const importanceOrder = { high: 0, medium: 1, low: 2 };
			const aImportance = a.analysis?.importance ?? "low";
			const bImportance = b.analysis?.importance ?? "low";
			return importanceOrder[aImportance] - importanceOrder[bImportance];
		});

		// Generate report string using template literals correctly
		let report = `==================================================
EMAILS REQUIRING RESPONSE
Generated on: ${new Date().toISOString()}
==================================================\n\n`;

		if (sortedEmails.length > 0) {
			for (const email of sortedEmails) {
				report += `Subject: ${email.subject}\n`;
				report += `From: ${email.from}\n`;
				report += `Received: ${email.receivedDateTime}\n`;
				report += `Importance: ${(email.analysis?.importance ?? "low").toUpperCase()}\n`;
				report += `Time Sensitive: ${(email.analysis?.time_sensitive ?? false) ? "YES" : "No"}\n`;
				report += `Topics: ${(email.analysis?.topics ?? []).join(", ")}\n`;
				report += `Reason: ${email.analysis?.reason ?? "N/A"}\n`;
				if (email.already_responded) {
					report += "STATUS: ✅ ALREADY RESPONDED\n"; // Simple string, no template literal
				}
				report += `Preview: ${email.body.substring(0, 300)}...\n\n`;
				report += "--------------------------------------------------\n\n"; // Simple string, no template literal
			}
		} else {
			report += "No emails requiring immediate response were found.\n\n"; // Simple string, no template literal
		}

		const output: NeedsResponseOutput = {
			last_updated: new Date().toISOString(),
			needs_response_emails: sortedEmails,
			report: report,
			analyzed_emails: displayAnalyzedEmails,
		};

		console.log(
			`Processed ${fetchedEmails.length} emails in total (batch analysis).`,
		);
		console.log(`Emails requiring response: ${needsResponseEmails.length}`);
		const alreadyRespondedCount = needsResponseEmails.filter(
			(e) => e.already_responded,
		).length;
		console.log(`Previously responded to: ${alreadyRespondedCount}`);
		console.log(
			`New emails requiring response: ${needsResponseEmails.length - alreadyRespondedCount}`,
		);

		return c.json(output);
	} catch (error) {
		console.error("Error in /analyze-emails route:", error);
		return c.json(
			{
				error: "Failed to analyze emails.",
				details: (error as Error)?.message || String(error),
			},
			500,
		);
	}
});

app.post("/delete/:id", async (c: Context<Env>) => {
	const emailId = c.req.param("id");
	if (!emailId) {
		return c.json({ error: "Email ID is required" }, 400);
	}

	try {
		const oauth2Client = getOAuth2Client(c);
		const gmail = google.gmail({ version: "v1", auth: oauth2Client });

		console.log(`Attempting to trash email with ID: ${emailId}`);

		await gmail.users.messages.trash({
			userId: "me",
			id: emailId,
		});

		console.log(`Email with ID: ${emailId} successfully moved to trash.`);
		return c.json({
			message: `Email with ID: ${emailId} successfully moved to trash.`,
		});
	} catch (error) {
		const gapiError = error as GApiError; // Cast to our more specific error type
		console.error(
			`Error trashing email with ID ${emailId}:`,
			gapiError.message,
		);
		// Check for specific GAPI errors if possible, e.g., not found or permission issues
		if (gapiError.code === 404) {
			return c.json(
				{ error: "Email not found.", details: gapiError.message },
				404,
			);
		}
		if (gapiError.code === 403) {
			return c.json(
				{
					error:
						"Permission denied. Ensure the correct Gmail API scopes are granted (e.g., gmail.modify).",
					details: gapiError.message,
				},
				403,
			);
		}
		return c.json(
			{ error: "Failed to trash email.", details: gapiError.message },
			500,
		);
	}
});

export default app;
