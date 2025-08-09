require("dotenv").config();

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const nodemailer = require("nodemailer");

const SMTP_USERNAME = process.env.SMTP_USERNAME;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const LLMGATEWAY_API_KEY = process.env.LLMGATEWAY_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const EMAIL_COUNT = parseInt(process.env.EMAIL_COUNT) || 10;
const DB_PATH = process.env.DB_PATH ? path.join(__dirname, process.env.DB_PATH) : path.join(__dirname, "contributor_emails.db");

// Close API configuration (optional)
const CLOSE_API_KEY = process.env.CLOSE_API_KEY;
const CLOSE_API_URL = process.env.CLOSE_API_URL || "https://api.close.com/api/v1";
// const CLOSE_CONTACT_ID = process.env.CLOSE_CONTACT_ID;
// const CLOSE_USER_ID = process.env.CLOSE_USER_ID;
// const CLOSE_LEAD_ID = process.env.CLOSE_LEAD_ID;
const CLOSE_EMAIL_ACCOUNT_ID = process.env.CLOSE_EMAIL_ACCOUNT_ID;
const USE_CLOSE_API = process.env.USE_CLOSE_API === "true";

// Email configuration
const FROM_EMAIL = process.env.FROM_EMAIL || "hello@usellmgateway.com";
const FROM_NAME = process.env.FROM_NAME || "Luca from LLMGateway";
const EMAIL_SUBJECT = process.env.EMAIL_SUBJECT || "The actual \"Open\" alternative to OpenRouter";

// Utility functions to promisify sqlite3 operations
function openDatabase(dbPath) {
	return new Promise((resolve, reject) => {
		const database = new sqlite3.Database(dbPath, (err) => {
			if (err) {
				reject(err);
			} else {
				resolve(database);
			}
		});
	});
}

function allQuery(db, query, params = []) {
	return new Promise((resolve, reject) => {
		db.all(query, params, (err, rows) => {
			if (err) {
				reject(err);
			} else {
				resolve(rows);
			}
		});
	});
}

function runQuery(db, query, params = []) {
	return new Promise((resolve, reject) => {
		db.run(query, params, function (err) {
			if (err) {
				reject(err);
			} else {
				resolve(this);
			}
		});
	});
}

function closeDatabase(db) {
	return new Promise((resolve, reject) => {
		db.close((err) => {
			if (err) {
				reject(err);
			} else {
				resolve();
			}
		});
	});
}

// Initialize nodemailer with Mailtrap SMTP
function createMailTransporter() {
	return nodemailer.createTransport({
		host: process.env.SMTP_HOST || "sandbox.smtp.mailtrap.io",
		port: 2525,
		auth: {
			user: process.env.SMTP_USERNAME,
			pass: process.env.SMTP_PASSWORD,
		},
	});
}

// Fetch unique email addresses with repo info from database
async function fetchEmailsToSend(db, count) {
	try {
		const query = `
			SELECT DISTINCT email, repo_name, keyword
			FROM emails
			WHERE ignore = 0
				AND approved = 0
				AND email_sent = 0
				AND email NOT LIKE '%noreply%'
				AND email LIKE '%@%'
				AND repo_name IS NOT NULL
			ORDER BY created_at DESC LIMIT ?
		`;

		const emails = await allQuery(db, query, [count]);
		return emails;
	} catch (error) {
		console.error("Error fetching emails from database:", error.message);
		throw error;
	}
}

// Fetch repository information from GitHub API
async function fetchRepoInfo(repoName) {
	try {
		const headers = {
			"Accept": "application/vnd.github+json",
			"Authorization": `Bearer ${GITHUB_TOKEN}`,
			"User-Agent": "LLMGateway-Outreach",
		};

		// Get repository info
		const repoResponse = await fetch(`https://api.github.com/repos/${repoName}`, { headers });
		if (!repoResponse.ok) {
			throw new Error(`GitHub API error: ${repoResponse.status}`);
		}
		const repoData = await repoResponse.json();

		// Get README content
		let readmeContent = "";
		try {
			const readmeResponse = await fetch(`https://api.github.com/repos/${repoName}/readme`, { headers });
			if (readmeResponse.ok) {
				const readmeData = await readmeResponse.json();
				readmeContent = Buffer.from(readmeData.content, "base64").toString("utf-8");
				// Limit README to first 2000 characters
				if (readmeContent.length > 2000) {
					readmeContent = readmeContent.substring(0, 2000) + "...";
				}
			}
		} catch (readmeError) {
			console.log(`  No README found for ${repoName}`);
		}

		return {
			name: repoData.name,
			fullName: repoData.full_name,
			description: repoData.description || "",
			language: repoData.language || "Unknown",
			stars: repoData.stargazers_count || 0,
			readme: readmeContent,
		};
	} catch (error) {
		console.error(`Error fetching repo info for ${repoName}:`, error.message);
		return null;
	}
}

// Analyze repository using LLMGateway
async function analyzeRepository(repoInfo) {
	try {
		const prompt = `Analyze this GitHub repository and write a natural 2-3 sentence description that flows well in an email. The description should naturally mention if the project likely uses AI/LLM services or APIs, and seamlessly work in a sentence like "I came across your work on [repo] and was impressed by what you've built. [YOUR DESCRIPTION]"

Repository: ${repoInfo.fullName}
Description: ${repoInfo.description}
Language: ${repoInfo.language}
Stars: ${repoInfo.stars}

DO NOT include the "I came across your work" in the output. Make sure the description is as accurate as possible.

README content:
${repoInfo.readme}

Write a natural, conversational description that would fit perfectly after "I was impressed by what you've built." Focus on what makes the project interesting and mention AI/LLM usage if relevant. Keep it under 120 chars and make it sound genuine and personal.`;

		const response = await fetch("https://api.llmgateway.io/v1/chat/completions", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${LLMGATEWAY_API_KEY}`,
				"X-LLMGateway-Kind": "bulk-email-summary",
			},
			body: JSON.stringify({
				model: "gpt-5-mini",
				messages: [
					{
						role: "user",
						content: prompt,
					},
				],
			}),
		});

		if (!response.ok) {
			throw new Error(`LLMGateway API error: ${response.status}`);
		}

		const data = await response.json();

		return data.choices[0].message.content.trim();
	} catch (error) {
		throw new Error(`Error analyzing repository: ${error.message}`);
	}
}

// Generate personalized email content
function generatePersonalizedEmail(repoAnalysis, repoInfo, keyword) {
	const isOpenRouter = keyword && keyword.toLowerCase() === "openrouter";

	if (isOpenRouter) {
		return `Hi there!

I came across your work on ${repoInfo.fullName} and was impressed by what you've built. ${repoAnalysis}

Given the nature of your project, I thought you might find LLMGateway (https://llmgateway.io) interesting - it's a self-hosted alternative to OpenRouter (read the full email for free credits!) that gives you:

• Fully open source & self-hostable
• Deep analytics and usage insights
• Intelligent routing for cost & performance optimization

Unlike hosted services, LLMGateway can be deployed in your own environment, giving you full visibility into costs, usage patterns, and model performance. This is particularly valuable for production applications where you need predictable costs and complete data control.

We also have a hosted version of LLMGateway to get started quickly. Just reply here with your registered email and I'll give you a few credits for free to try it out.

Cheers,
${FROM_NAME}
https://llmgateway.io`;
	} else {
		return `Hi there!

I came across your work on ${repoInfo.fullName} and was impressed by what you've built. ${repoAnalysis}

Given that you're working with AI, I thought you might find LLMGateway (https://llmgateway.io) interesting - instead of being locked into a single AI provider, an API gateway gives you:

• Access to 200+ models from multiple providers in one unified API
• Intelligent routing to automatically choose the best model for cost & performance
• Deep analytics to understand usage patterns and optimize spend
• Fallback handling when providers have outages or rate limits

Unlike single-provider solutions, LLMGateway gives you flexibility to switch between providers without changing code, compare model performance side-by-side, and avoid vendor lock-in. This is particularly valuable for production applications where you need reliability and cost control.

We also have a hosted version to get started quickly. Just reply here with your registered email and I'll give you a few credits for free to try it out.

Cheers,
${FROM_NAME}
https://llmgateway.io`;
	}
}

// Send personalized email using nodemailer
async function sendEmail(transporter, toEmail, emailContent) {
	try {
		const mailOptions = {
			from: {
				name: FROM_NAME,
				address: FROM_EMAIL,
			},
			to: toEmail,
			subject: EMAIL_SUBJECT,
			text: emailContent,
		};

		const result = await transporter.sendMail(mailOptions);
		console.log(`✅ Email sent to ${toEmail} - Message ID: ${result.messageId}`);
		return true;
	} catch (error) {
		console.error(`❌ Failed to send email to ${toEmail}:`, error.message);
		return false;
	}
}

// Find or create lead by repository and ensure contact exists for email
async function findOrCreateLead(email, repoInfo) {
	try {
		if (!repoInfo.fullName) {
			throw new Error(`No repository name found for ${repoInfo}`);
		}
		const repoName = repoInfo.fullName;

		// First, search for existing lead for this repository
		const searchResponse = await fetch(`${CLOSE_API_URL}/lead/?query=custom.Repository:"${repoName}"`, {
			method: "GET",
			headers: {
				"Authorization": `Basic ${Buffer.from(`${CLOSE_API_KEY}:`).toString("base64")}`,
			},
		});

		if (!searchResponse.ok) {
			throw new Error(`Failed to search for lead: ${searchResponse.status}`);
		}

		const searchData = await searchResponse.json();
		let lead = null;

		// If lead exists for this repository, use it
		if (searchData.data && searchData.data.length > 0) {
			lead = searchData.data[0];
			console.log(`📋 Found existing lead for repository ${repoName}: ${lead.id}`);
		} else {
			// Create new lead for this repository
			console.log(`➕ Creating new lead for repository ${repoName}...`);
			const leadData = {
				name: `Contributors - ${repoName}`,
				custom: {
					"Repository": repoName,
					"Language": repoInfo ? repoInfo.language : "",
					"Stars": repoInfo ? repoInfo.stars : 0,
				},
			};

			const createResponse = await fetch(`${CLOSE_API_URL}/lead/`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Basic ${Buffer.from(`${CLOSE_API_KEY}:`).toString("base64")}`,
				},
				body: JSON.stringify(leadData),
			});

			if (!createResponse.ok) {
				const errorData = await createResponse.text();
				throw new Error(`Failed to create lead: ${createResponse.status} - ${errorData}`);
			}

			lead = await createResponse.json();
			console.log(`✅ Created new lead for repository ${repoName}: ${lead.id}`);
		}

		// Now check if contact with this email exists on this lead
		const contactExists = lead.contacts && lead.contacts.some(contact =>
			contact.emails && contact.emails.some(emailObj => emailObj.email === email),
		);

		if (contactExists) {
			console.log(`📧 Contact with email ${email} already exists on lead ${lead.id}`);
			return lead;
		}

		// Create new contact for this email on the lead
		console.log(`➕ Adding new contact ${email} to lead ${lead.id}...`);
		const contactData = {
			lead_id: lead.id,
			name: email.split("@")[0], // Use email prefix as contact name
			emails: [{
				email: email,
				type: "office",
			}],
		};

		const contactResponse = await fetch(`${CLOSE_API_URL}/contact/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Basic ${Buffer.from(`${CLOSE_API_KEY}:`).toString("base64")}`,
			},
			body: JSON.stringify(contactData),
		});

		if (!contactResponse.ok) {
			const errorData = await contactResponse.text();
			throw new Error(`Failed to create contact: ${contactResponse.status} - ${errorData}`);
		}

		const newContact = await contactResponse.json();
		console.log(`✅ Added contact ${email} to lead: ${newContact.id}`);

		// Refresh lead data to include new contact
		const refreshResponse = await fetch(`${CLOSE_API_URL}/lead/${lead.id}/`, {
			method: "GET",
			headers: {
				"Authorization": `Basic ${Buffer.from(`${CLOSE_API_KEY}:`).toString("base64")}`,
			},
		});

		if (refreshResponse.ok) {
			return await refreshResponse.json();
		} else {
			// Fallback: manually add contact to lead object
			if (!lead.contacts) lead.contacts = [];
			lead.contacts.push(newContact);
			return lead;
		}

	} catch (error) {
		console.error(`❌ Error finding/creating lead for ${email} in ${repoInfo?.fullName}:`, error.message);
		throw error;
	}
}

// Send email using Close API
async function sendEmailViaClose(toEmail, emailContent, repoInfo) {
	try {
		// Find or create lead first
		const lead = await findOrCreateLead(toEmail, repoInfo);

		// Find the specific contact for this email
		const contact = lead.contacts && lead.contacts.find(contact =>
			contact.emails && contact.emails.some(emailObj => emailObj.email === toEmail),
		);

		if (!contact) {
			throw new Error(`No contact found for email ${toEmail} on lead ${lead.id}`);
		}

		const emailPayload = {
			contact_id: contact.id,
			lead_id: lead.id,
			direction: "outgoing",
			created_by_name: FROM_NAME,
			subject: EMAIL_SUBJECT,
			sender: FROM_EMAIL,
			to: [toEmail],
			bcc: [],
			cc: [],
			status: "outbox",
			body_text: emailContent,
			body_html: emailContent.replace(/\n/g, "<br>"),
			attachments: [],
			email_account_id: CLOSE_EMAIL_ACCOUNT_ID,
			template_id: null,
		};

		const response = await fetch(`${CLOSE_API_URL}/activity/email/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Basic ${Buffer.from(`${CLOSE_API_KEY}:`).toString("base64")}`,
			},
			body: JSON.stringify(emailPayload),
		});

		if (!response.ok) {
			const errorData = await response.text();
			throw new Error(`Close API error: ${response.status} - ${errorData}`);
		}

		const result = await response.json();
		console.log(`✅ Email sent via Close API to ${toEmail} - ID: ${result.id}`);
		return true;
	} catch (error) {
		console.error(`❌ Failed to send email via Close API to ${toEmail}:`, error.message);
		return false;
	}
}

// Mark email as sent and save email body in database
async function markEmailAsSent(db, email, emailBody) {
	try {
		// Update email as sent and save the email body
		await runQuery(db, "UPDATE emails SET email_sent = 1, email_body = ? WHERE email = ?", [emailBody, email]);
		console.log(`📝 Marked ${email} as sent and saved email body to database`);
	} catch (error) {
		console.error(`Error marking email as sent for ${email}:`, error.message);
	}
}

// Main function
async function main() {
	let db;

	try {
		console.log("🚀 Starting email sending process...");
		console.log(`📧 Target: ${EMAIL_COUNT} emails`);

		// Validate required environment variables
		if (USE_CLOSE_API) {
			if (!CLOSE_API_KEY || !CLOSE_EMAIL_ACCOUNT_ID) {
				throw new Error("When USE_CLOSE_API=true, CLOSE_API_KEY and CLOSE_EMAIL_ACCOUNT_ID environment variables are required");
			}
			console.log("📧 Using Close API for email sending");
		} else {
			if (!SMTP_USERNAME || !SMTP_PASSWORD) {
				throw new Error("SMTP_USERNAME and SMTP_PASSWORD environment variables are required when not using Close API");
			}
			console.log("📧 Using SMTP for email sending");
		}
		if (!LLMGATEWAY_API_KEY) {
			throw new Error("LLMGATEWAY_API_KEY environment variable is required");
		}
		if (!GITHUB_TOKEN) {
			throw new Error("GITHUB_TOKEN environment variable is required");
		}

		// Initialize database connection
		db = await openDatabase(DB_PATH);
		console.log(`📁 Connected to database: ${DB_PATH}`);

		// Fetch emails to send
		const emailsToSend = await fetchEmailsToSend(db, EMAIL_COUNT);
		console.log(`📋 Found ${emailsToSend.length} emails to send`);

		if (emailsToSend.length === 0) {
			console.log("No emails to send. All available emails may have been sent already or flagged as ignore.");
			return;
		}

		// Initialize email service
		let transporter = null;
		if (!USE_CLOSE_API) {
			transporter = createMailTransporter();

			// Verify SMTP connection
			try {
				await transporter.verify();
				console.log("📬 SMTP connection verified successfully");
			} catch (error) {
				throw new Error(`SMTP connection failed: ${error.message}`);
			}
		}

		// Send emails
		let successCount = 0;
		let failureCount = 0;

		for (let i = 0; i < emailsToSend.length; i++) {
			const emailRecord = emailsToSend[i];
			const email = emailRecord.email;
			const repoName = emailRecord.repo_name;
			const keyword = emailRecord.keyword;

			console.log(`\n[${i + 1}/${emailsToSend.length}] Processing: ${email} (${repoName}) [${keyword}]`);

			// Fetch and analyze repository
			console.log(`📖 Fetching repository info for ${repoName}...`);
			const repoInfo = await fetchRepoInfo(repoName);

			if (!repoInfo) {
				console.log(`⚠️ Could not fetch repo info for ${repoName}, skipping...`);
				failureCount++;
				continue;
			}

			console.log(`🧠 Analyzing repository with LLMGateway...`);
			const repoAnalysis = await analyzeRepository(repoInfo);
			console.log(`📝 Analysis: ${repoAnalysis.substring(0, 100)}...`);

			// Generate personalized email
			const personalizedEmail = generatePersonalizedEmail(repoAnalysis, repoInfo, keyword);

			// Send email
			console.log(`📧 Sending personalized email to ${email}...`);
			const success = USE_CLOSE_API
				? await sendEmailViaClose(email, personalizedEmail, repoInfo)
				: await sendEmail(transporter, email, personalizedEmail);

			if (success) {
				await markEmailAsSent(db, email, personalizedEmail);
				successCount++;
			} else {
				failureCount++;
			}

			// Rate limiting - wait 2 seconds between emails (increased due to API calls)
			if (i < emailsToSend.length - 1) {
				console.log("⏳ Waiting 2 seconds...");
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}

		// Summary
		console.log("\n=== EMAIL SENDING SUMMARY ===");
		console.log(`✅ Successfully sent: ${successCount}`);
		console.log(`❌ Failed to send: ${failureCount}`);
		console.log(`📊 Total processed: ${emailsToSend.length}`);

	} catch (error) {
		console.error("❌ Error in email sending process:", error.message);
		process.exit(1);
	} finally {
		// Close database connection
		if (db) {
			try {
				await closeDatabase(db);
				console.log("📁 Database connection closed");
			} catch (err) {
				console.error("Error closing database:", err.message);
			}
		}
	}
}

// Run the application
if (require.main === module) {
	main();
}

module.exports = { main };
