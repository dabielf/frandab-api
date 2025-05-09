import { Hono, type Context } from "hono";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { generateObject } from "ai";
import type { gmail_v1 } from "@googleapis/gmail";
import { google } from "googleapis";
import type { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import { html } from "hono/html";

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
	num_emails: number;
	analyzed_emails: DisplayAnalyzedEmail[];
}

interface BatchAnalyzedEmail {
	emailId: string;
	importance: "high" | "medium" | "low";
	reason: string;
	needs_response: boolean;
	time_sensitive: boolean;
	topics: string[];
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
		KV: KVNamespace; // Added KV binding type
	};
}

const app = new Hono<Env>();

// --- Cache Constants ---
const GMAIL_FETCHED_EMAILS_CACHE_KEY = "gmail_fetched_emails_v1";
const GMAIL_ANALYSIS_RESULTS_CACHE_KEY = "gmail_analysis_results_v1";
const CACHE_TTL_SECONDS = 60 * 30; // 30 minutes

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
): Promise<BatchAnalyzedEmail[]> {
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
			(analysisResults as BatchAnalyzedEmail[]).length,
		);
		return analysisResults as BatchAnalyzedEmail[];
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

		const forceRefresh = c.req.query("refresh") === "true";
		let fetchedEmails: FetchedEmail[] | null = null;
		let fetchedEmailsCameFromCache = false;
		let batchAnalysisResults: BatchAnalyzedEmail[] | null = null;

		if (!forceRefresh) {
			try {
				console.log(
					`JSON Route: Attempting to read '${GMAIL_FETCHED_EMAILS_CACHE_KEY}' from KV cache...`,
				);
				const cachedData = await c.env.KV.get(GMAIL_FETCHED_EMAILS_CACHE_KEY, {
					type: "json",
				});
				if (cachedData) {
					fetchedEmails = cachedData as FetchedEmail[];
					fetchedEmailsCameFromCache = true;
					console.log(
						`JSON Route: Successfully loaded ${fetchedEmails?.length || 0} emails from KV cache.`,
					);
				} else {
					console.log(
						"JSON Route: No data found in email KV cache or cache expired.",
					);
				}
			} catch (kvError) {
				console.error("JSON Route: Error reading from email KV cache:", kvError);
			}
		} else {
			console.log("JSON Route: Force refresh triggered for emails.");
		}

		if (!fetchedEmails) {
			console.log(
				"JSON Route: Fetching emails from Gmail (email cache miss or force refresh)...",
			);
			fetchedEmailsCameFromCache = false; // Explicitly set as emails will be fresh
			const emailsFromGmail = await getEmailsFromGmail(gmail, 24);
			if (emailsFromGmail && emailsFromGmail.length >= 0) {
				fetchedEmails = emailsFromGmail;
				try {
					console.log(
						`JSON Route: Storing ${fetchedEmails.length} fetched emails into KV cache ('${GMAIL_FETCHED_EMAILS_CACHE_KEY}')...`,
					);
					await c.env.KV.put(
						GMAIL_FETCHED_EMAILS_CACHE_KEY,
						JSON.stringify(fetchedEmails),
						{
							expirationTtl: CACHE_TTL_SECONDS,
						},
					);
					console.log("JSON Route: Successfully stored emails in KV cache.");
				} catch (kvError) {
					console.error("JSON Route: Error writing emails to KV cache:", kvError);
				}
			} else {
				fetchedEmails = []; // Ensure it's an empty array if Gmail fetch fails or returns no emails
			}
		}

		// Ensure fetchedEmails is not null before proceeding to analysis
		if (fetchedEmails === null) fetchedEmails = [];

		// Now handle batchAnalysisResults caching
		const shouldFetchAnalysisFresh = forceRefresh || !fetchedEmailsCameFromCache;

		if (!shouldFetchAnalysisFresh) {
			try {
				console.log(`JSON Route: Attempting to read '${GMAIL_ANALYSIS_RESULTS_CACHE_KEY}' from KV cache...`);
				const cachedAnalysis = await c.env.KV.get(GMAIL_ANALYSIS_RESULTS_CACHE_KEY, { type: "json" });
				if (cachedAnalysis) {
					batchAnalysisResults = cachedAnalysis as BatchAnalyzedEmail[];
					console.log(`JSON Route: Successfully loaded ${batchAnalysisResults?.length || 0} analysis results from KV cache.`);
				} else {
					console.log("JSON Route: No data found in analysis KV cache or cache expired.");
				}
			} catch (kvError) {
				console.error("JSON Route: Error reading from analysis KV cache:", kvError);
			}
		}

		if (!batchAnalysisResults) {
			if (shouldFetchAnalysisFresh) {
				console.log("JSON Route: Computing fresh analysis results (force refresh or fresh emails).");
			} else {
				console.log("JSON Route: Computing fresh analysis results (analysis cache miss).");
			}
			batchAnalysisResults = await analyzeBatchEmailImportanceWithAISDK(c, fetchedEmails);
			try {
				console.log(`JSON Route: Storing ${batchAnalysisResults.length} analysis results into KV cache ('${GMAIL_ANALYSIS_RESULTS_CACHE_KEY}')...`);
				await c.env.KV.put(GMAIL_ANALYSIS_RESULTS_CACHE_KEY, JSON.stringify(batchAnalysisResults), {
					expirationTtl: CACHE_TTL_SECONDS,
				});
				console.log("JSON Route: Successfully stored analysis results in KV cache.");
			} catch (kvError) {
				console.error("JSON Route: Error writing analysis results to KV cache:", kvError);
			}
		}

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
			num_emails: fetchedEmails.length,
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

		// Attempt to update the KV cache
		try {
			console.log(
				`Attempting to remove email ${emailId} from KV cache ('${GMAIL_FETCHED_EMAILS_CACHE_KEY}')...`,
			);
			const cachedEmails = await c.env.KV.get(GMAIL_FETCHED_EMAILS_CACHE_KEY, {
				type: "json",
			});
			if (cachedEmails && Array.isArray(cachedEmails)) {
				const updatedCachedEmails = (cachedEmails as FetchedEmail[]).filter(
					(email) => email.id !== emailId,
				);
				if (
					updatedCachedEmails.length < (cachedEmails as FetchedEmail[]).length
				) {
					await c.env.KV.put(
						GMAIL_FETCHED_EMAILS_CACHE_KEY,
						JSON.stringify(updatedCachedEmails),
						{
							expirationTtl: CACHE_TTL_SECONDS,
						},
					);
					console.log(
						`Successfully removed email ${emailId} from KV cache and updated.`,
					);
					// Update the analysis cache by removing the specific email's analysis
					try {
						console.log(`Attempting to update analysis cache ('${GMAIL_ANALYSIS_RESULTS_CACHE_KEY}') for deleted email ${emailId}...`);
						const cachedAnalysis = await c.env.KV.get(GMAIL_ANALYSIS_RESULTS_CACHE_KEY, { type: "json" });
						if (cachedAnalysis && Array.isArray(cachedAnalysis)) {
							const updatedAnalysisResults = (cachedAnalysis as BatchAnalyzedEmail[]).filter(analysis => analysis.emailId !== emailId);
							if (updatedAnalysisResults.length < (cachedAnalysis as BatchAnalyzedEmail[]).length) {
								await c.env.KV.put(GMAIL_ANALYSIS_RESULTS_CACHE_KEY, JSON.stringify(updatedAnalysisResults), {
									expirationTtl: CACHE_TTL_SECONDS,
								});
								console.log(`Successfully removed analysis for email ${emailId} from KV cache and updated analysis cache.`);
							} else {
								console.log(`Analysis for email ${emailId} not found in analysis KV cache, no update needed.`);
							}
						} else {
							console.log("Analysis KV cache is empty or not an array, skipping update for deletion.");
						}
					} catch (kvAnalysisError) {
						console.error(`Error updating analysis KV cache for deleted email ${emailId}:`, kvAnalysisError);
						// Do not let this error block the main success response
					}
				} else {
					console.log(
						`Email ${emailId} not found in KV cache, no update needed.`,
					);
				}
			} else {
				console.log(
					"KV cache is empty or not an array, skipping cache update for deletion.",
				);
			}
		} catch (kvError) {
			console.error(
				`Error updating KV cache after deleting email ${emailId}:`,
				kvError,
			);
			// Do not let KV error block the main success response for Gmail deletion
		}

		return c.json({
			message: `Email with ID: ${emailId} successfully moved to trash. Cache updated.`,
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

app.get("/analyze-emails-html", async (c: Context<Env>) => {
	const styles = html`
    <style>
      body {
        font-family: sans-serif;
        margin: 20px;
        background-color: #f4f4f9;
        color: #333;
      }
      h1 {
        color: #333;
        border-bottom: 2px solid #ccc;
        padding-bottom: 10px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
        margin-top: 20px;
        box-shadow: 0 2px 3px rgba(0,0,0,0.1);
      }
      th,
      td {
        border: 1px solid #ddd;
        padding: 10px;
        text-align: left;
      }
      th {
        background-color: #e9e9e9;
        color: #333;
      }
      tr:nth-child(even) {
        background-color: #f9f9f9;
      }
      tr:hover {
        background-color: #f1f1f1;
      }
      .button-delete {
        background-color: #f44336;
        color: white;
        padding: 5px 10px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 14px;
      }
      .button-delete:hover {
        background-color: #da190b;
      }
      .topics-list {
        list-style-type: disc;
        padding-left: 20px;
        margin: 0;
      }
      .topics-list li {
        margin-bottom: 4px;
      }
      .button-refresh {
        background-color: #4CAF50; /* Green */
        color: white;
        padding: 10px 15px;
        margin-bottom: 20px;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        font-size: 16px;
      }
      .button-refresh:hover {
        background-color: #45a049;
      }
    </style>
  `;
	try {
		const oauth2Client = getOAuth2Client(c);
		const gmail = google.gmail({ version: "v1", auth: oauth2Client });

		const forceRefresh = c.req.query("refresh") === "true";
		let fetchedEmails: FetchedEmail[] | null = null;
		let fetchedEmailsCameFromCache = false;
		let batchAnalysisResults: BatchAnalyzedEmail[] | null = null;

		if (!forceRefresh) {
			try {
				console.log(
					`HTML Route: Attempting to read '${GMAIL_FETCHED_EMAILS_CACHE_KEY}' from KV cache...`,
				);
				const cachedData = await c.env.KV.get(GMAIL_FETCHED_EMAILS_CACHE_KEY, {
					type: "json",
				});
				if (cachedData) {
					fetchedEmails = cachedData as FetchedEmail[];
					fetchedEmailsCameFromCache = true;
					console.log(
						`HTML Route: Successfully loaded ${fetchedEmails?.length || 0} emails from KV cache.`,
					);
				} else {
					console.log(
						"HTML Route: No data found in email KV cache or cache expired.",
					);
				}
			} catch (kvError) {
				console.error("HTML Route: Error reading from email KV cache:", kvError);
			}
		} else {
			console.log("HTML Route: Force refresh triggered for emails.");
		}

		if (!fetchedEmails) {
			console.log(
				"HTML Route: Fetching emails from Gmail (email cache miss or force refresh)...",
			);
			fetchedEmailsCameFromCache = false; // Explicitly set as emails will be fresh
			const emailsFromGmail = await getEmailsFromGmail(gmail, 24);
			if (emailsFromGmail && emailsFromGmail.length >= 0) {
				fetchedEmails = emailsFromGmail;
				try {
					console.log(
						`HTML Route: Storing ${fetchedEmails.length} fetched emails into KV cache ('${GMAIL_FETCHED_EMAILS_CACHE_KEY}')...`,
					);
					await c.env.KV.put(
						GMAIL_FETCHED_EMAILS_CACHE_KEY,
						JSON.stringify(fetchedEmails),
						{
							expirationTtl: CACHE_TTL_SECONDS,
						},
					);
					console.log("HTML Route: Successfully stored emails in KV cache.");
				} catch (kvError) {
					console.error("HTML Route: Error writing emails to KV cache:", kvError);
				}
			} else {
				fetchedEmails = []; // Ensure it's an empty array if Gmail fetch fails or returns no emails
			}
		}

		// Ensure fetchedEmails is not null
		if (fetchedEmails === null) fetchedEmails = [];

		if (fetchedEmails.length === 0 && !forceRefresh && fetchedEmailsCameFromCache) {
			// If cache was hit, it was empty, and we're not forcing a refresh, show no emails message from cache.
			// Otherwise, if forceRefresh is true or fetchedEmailsCameFromCache is false,
			// the !fetchedEmails || fetchedEmails.length === 0 check below will handle it after attempting Gmail fetch.
			console.log("HTML Route: No emails found in cache, and not forcing refresh. Displaying no emails page.");
			return c.html(html`
				<!DOCTYPE html>
				<html>
				<head><title>Analyzed Emails</title>${styles}</head>
				<body>
					<button onclick="window.location.href='?refresh=true'" class="button-refresh">Refresh Data</button>
					<h1>No Emails Found</h1>
					<p>No emails were found in your inbox for the last 24 hours, or the cache is empty. Try refreshing the data.</p>
				</body>
				</html>
			`);
		}

		// Now handle batchAnalysisResults caching
		const shouldFetchAnalysisFresh = forceRefresh || !fetchedEmailsCameFromCache;

		if (!shouldFetchAnalysisFresh) {
			try {
				console.log(`HTML Route: Attempting to read '${GMAIL_ANALYSIS_RESULTS_CACHE_KEY}' from KV cache...`);
				const cachedAnalysis = await c.env.KV.get(GMAIL_ANALYSIS_RESULTS_CACHE_KEY, { type: "json" });
				if (cachedAnalysis) {
					batchAnalysisResults = cachedAnalysis as BatchAnalyzedEmail[];
					console.log(`HTML Route: Successfully loaded ${batchAnalysisResults?.length || 0} analysis results from KV cache.`);
				} else {
					console.log("HTML Route: No data found in analysis KV cache or cache expired.");
				}
			} catch (kvError) {
				console.error("HTML Route: Error reading from analysis KV cache:", kvError);
			}
		}

		if (!batchAnalysisResults) {
			if (shouldFetchAnalysisFresh) {
				console.log("HTML Route: Computing fresh analysis results (force refresh or fresh emails).");
			} else {
				console.log("HTML Route: Computing fresh analysis results (analysis cache miss).");
			}
			batchAnalysisResults = await analyzeBatchEmailImportanceWithAISDK(c, fetchedEmails ?? []);
			try {
				console.log(`HTML Route: Storing ${batchAnalysisResults.length} analysis results into KV cache ('${GMAIL_ANALYSIS_RESULTS_CACHE_KEY}')...`);
				await c.env.KV.put(GMAIL_ANALYSIS_RESULTS_CACHE_KEY, JSON.stringify(batchAnalysisResults), {
					expirationTtl: CACHE_TTL_SECONDS,
				});
				console.log("HTML Route: Successfully stored analysis results in KV cache.");
			} catch (kvError) {
				console.error("HTML Route: Error writing analysis results to KV cache:", kvError);
			}
		}

		// Fallback for no emails after all attempts (Gmail fetch and/or cache for emails/analysis)
		if (!fetchedEmails || fetchedEmails.length === 0) {
			console.log(
				"HTML Route: No emails fetched to analyze (after cache and Gmail attempt).",
			);
			return c.html(html`
				<!DOCTYPE html>
				<html>
				<head><title>Analyzed Emails</title>${styles}</head>
				<body>
					<button onclick="window.location.href='?refresh=true'" class="button-refresh">Refresh Data</button>
					<h1>No Emails Found</h1>
					<p>No emails were found in your inbox for the last 24 hours, or the cache is empty. Try refreshing the data.</p>
				</body>
				</html>
			`);
		}

		console.log(
			`HTML Route: Fetched ${fetchedEmails.length} emails. Starting display generation with ${batchAnalysisResults?.length || 0} analysis results...`,
		);

		// Ensure batchAnalysisResults is not null before proceeding
		if (batchAnalysisResults === null) batchAnalysisResults = [];

		console.log(
			`HTML Route: Finished batch analysis. Received ${batchAnalysisResults.length} results from AI (or cache).`,
		);

		// Note: Sent email checking for 'already_responded' is part of the needsResponseEmails logic,
		// but for displayAnalyzedEmails, we mainly use the direct analysis results.
		// We can still fetch sent emails if needed for other context, but it's not directly used for this display list construction.

		const displayAnalyzedEmails: DisplayAnalyzedEmail[] = [];
		const fetchedEmailsMap = new Map(
			fetchedEmails.map((email) => [email.id, email]),
		);

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
			} else {
				console.warn(
					`HTML Route: AI returned analysis for an unknown/unmatched emailId: ${analysis.emailId}`,
				);
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

		// Sort by importance (High > Medium > Low) then by time sensitivity
		displayAnalyzedEmails.sort((a, b) => {
			const importanceOrder = { high: 0, medium: 1, low: 2 };
			if (importanceOrder[a.importance] !== importanceOrder[b.importance]) {
				return importanceOrder[a.importance] - importanceOrder[b.importance];
			}
			if (a.time_sensitive !== b.time_sensitive) {
				return a.time_sensitive ? -1 : 1; // Time sensitive first
			}
			return 0;
		});

		return c.html(html`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Analyzed Emails</title>
        ${styles}
        <script>
          async function deleteEmail(emailId) {
            if (!confirm('Are you sure you want to delete email ' + emailId + '? This action cannot be undone.')) {
              return;
            }
            try {
              const response = await fetch('/api/gmail/delete/' + emailId, {
                method: 'POST',
              });
              if (response.ok) {
                // Remove the row from the table
                const row = document.getElementById('email-row-' + emailId);
                if (row) {
                  row.remove();
                }
                // Update the count in the header
                const emailCountElement = document.getElementById('email-count');
                if (emailCountElement) {
                  const currentCount = parseInt(emailCountElement.innerText, 10);
                  if (!isNaN(currentCount)) {
                    emailCountElement.innerText = (currentCount - 1).toString();
                  }
                }
              } else {
                const errorResult = await response.json();
                alert('Failed to delete email: ' + (errorResult.details || response.statusText));
              }
            } catch (error) {
              console.error('Error deleting email:', error);
              alert('An error occurred while trying to delete the email.');
            }
          }
        </script>
      </head>
      <body>
        <button class="button-refresh" onclick="window.location.href='?refresh=true'">Refresh Data</button>
        <h1>Analyzed Emails (${displayAnalyzedEmails.length})</h1>
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>From</th>
              <th>Subject</th>
              <th>Importance</th>
              <th>Reason</th>
              <th>Needs Response</th>
              <th>Time Sensitive</th>
              <th>Topics</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${displayAnalyzedEmails.map(
							(email) => html`
              <tr id="email-row-${email.id}">
                <td>${email.id}</td>
                <td>${email.from}</td>
                <td>${email.subject}</td>
                <td>${email.importance.toUpperCase()}</td>
                <td>${email.reason}</td>
                <td>${email.needs_response ? "Yes" : "No"}</td>
                <td>${email.time_sensitive ? "Yes" : "No"}</td>
                <td>
                  ${
										email.topics && email.topics.length > 0
											? html`<ul class="topics-list">${email.topics.map((topic) => html`<li>${topic}</li>`)}</ul>`
											: "N/A"
									}
                </td>
                <td>
                  <button class="button-delete" onclick="deleteEmail('${email.id}')">Delete</button>
                </td>
              </tr>
            `,
						)}
          </tbody>
        </table>
        ${displayAnalyzedEmails.length === 0 ? html`<p>No emails matching criteria to display.</p>` : ""}
      </body>
      </html>
    `);
	} catch (error) {
		console.error("Error in /analyze-emails-html route:", error);
		return c.html(
			html`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Error</title>
        <style>
          body { font-family: sans-serif; margin: 20px; background-color: #fdd; color: #900; }
          h1 { color: #c00; }
          pre { background-color: #fff0f0; border: 1px solid #ffaaaa; padding: 10px; white-space: pre-wrap; word-wrap: break-word; }
        </style>
      </head>
      <body>
        <h1>Error Analyzing Emails</h1>
        <p>Sorry, something went wrong while analyzing the emails:</p>
        <pre>${(error as Error)?.message || String(error)}</pre>
        <p><a href="/analyze-emails-html">Try again</a></p>
      </body>
      </html>
    `,
			500,
		);
	}
});

export default app;
