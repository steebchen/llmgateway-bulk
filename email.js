require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');

const SMTP_USERNAME = process.env.SMTP_USERNAME;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;
const LLMGATEWAY_API_KEY = process.env.LLMGATEWAY_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const EMAIL_COUNT = parseInt(process.env.EMAIL_COUNT) || 10;
const DB_PATH = process.env.DB_PATH ? path.join(__dirname, process.env.DB_PATH) : path.join(__dirname, 'contributor_emails.db');

// Email configuration
const FROM_EMAIL = process.env.FROM_EMAIL || 'hello@llmgateway.io';
const FROM_NAME = process.env.FROM_NAME || 'LLMGateway Team';
const EMAIL_SUBJECT = process.env.EMAIL_SUBJECT || 'The actual "Open" alternative to OpenRouter';

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
		db.run(query, params, function(err) {
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
		host: "sandbox.smtp.mailtrap.io",
		port: 2525,
		auth: {
			user: process.env.SMTP_USERNAME,
			pass: process.env.SMTP_PASSWORD,
		}
	});
}

// Fetch unique email addresses with repo info from database
async function fetchEmailsToSend(db, count) {
	try {
		const query = `
			SELECT DISTINCT email, repo_name
			FROM emails
			WHERE ignore = 0
			AND approved = 0
			AND email_sent = 0
			AND email NOT LIKE '%noreply%'
			AND email LIKE '%@%'
			AND repo_name IS NOT NULL
			ORDER BY created_at DESC
			LIMIT ?
		`;

		const emails = await allQuery(db, query, [count]);
		return emails;
	} catch (error) {
		console.error('Error fetching emails from database:', error.message);
		throw error;
	}
}

// Fetch repository information from GitHub API
async function fetchRepoInfo(repoName) {
	try {
		const headers = {
			'Accept': 'application/vnd.github+json',
			'Authorization': `Bearer ${GITHUB_TOKEN}`,
			'User-Agent': 'LLMGateway-Outreach'
		};

		// Get repository info
		const repoResponse = await fetch(`https://api.github.com/repos/${repoName}`, { headers });
		if (!repoResponse.ok) {
			throw new Error(`GitHub API error: ${repoResponse.status}`);
		}
		const repoData = await repoResponse.json();

		// Get README content
		let readmeContent = '';
		try {
			const readmeResponse = await fetch(`https://api.github.com/repos/${repoName}/readme`, { headers });
			if (readmeResponse.ok) {
				const readmeData = await readmeResponse.json();
				readmeContent = Buffer.from(readmeData.content, 'base64').toString('utf-8');
				// Limit README to first 2000 characters
				if (readmeContent.length > 2000) {
					readmeContent = readmeContent.substring(0, 2000) + '...';
				}
			}
		} catch (readmeError) {
			console.log(`  No README found for ${repoName}`);
		}

		return {
			name: repoData.name,
			fullName: repoData.full_name,
			description: repoData.description || '',
			language: repoData.language || 'Unknown',
			stars: repoData.stargazers_count || 0,
			readme: readmeContent
		};
	} catch (error) {
		console.error(`Error fetching repo info for ${repoName}:`, error.message);
		return null;
	}
}

// Analyze repository using LLMGateway
async function analyzeRepository(repoInfo) {
	try {
		const prompt = `Analyze this GitHub repository and provide a brief 2-3 sentence summary of what the project does and its main purpose:

Repository: ${repoInfo.fullName}
Description: ${repoInfo.description}
Language: ${repoInfo.language}
Stars: ${repoInfo.stars}

README content:
${repoInfo.readme}

Provide a concise summary focusing on the project's core functionality and use case. Do not include the product name again especially not at leading, it should be a natural description of the project. Keep it very subtle and short, max 200 chars.`;

		const response = await fetch('https://api.llmgateway.io/v1/chat/completions', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${LLMGATEWAY_API_KEY}`
			},
			body: JSON.stringify({
				model: 'google-ai-studio/gemini-2.5-pro',
				messages: [
					{
						role: 'user',
						content: prompt
					}
				]
			})
		});

		if (!response.ok) {
			throw new Error(`LLMGateway API error: ${response.status}`);
		}

		const data = await response.json();

		console.log('data', data);
		return data.choices[0].message.content.trim();
	} catch (error) {
		throw new Error(`Error analyzing repository: ${error.message}`);
	}
}

// Generate personalized email content
function generatePersonalizedEmail(repoAnalysis, repoInfo) {
	return `Hi there!

I came across your work on ${repoInfo.fullName} and was impressed by what you've built. ${repoAnalysis}

I wanted to reach out because I noticed you might be using OpenRouter for your project. We've built LLMGateway (https://llmgateway.io) - a self-hosted alternative that gives you:

• Complete control over your AI infrastructure
• Deep analytics and usage insights
• Cost optimization through intelligent routing
• No vendor lock-in - deploy anywhere
• Enterprise-grade security and compliance

Unlike hosted services, LLMGateway can be deployed in your own environment, giving you full visibility into costs, usage patterns, and model performance. This is particularly valuable for production applications where you need predictable costs and complete data control.

Would you be interested in learning more about how LLMGateway could benefit your ${repoInfo.language} projects? I'd be happy to show you a quick demo or answer any questions.

Best regards,
${FROM_NAME}
https://llmgateway.io`;
}

// Send personalized email using nodemailer
async function sendEmail(transporter, toEmail, emailContent) {
	try {
		const mailOptions = {
			from: {
				name: FROM_NAME,
				address: FROM_EMAIL
			},
			to: toEmail,
			subject: EMAIL_SUBJECT,
			text: emailContent
		};

		const result = await transporter.sendMail(mailOptions);
		console.log(`✅ Email sent to ${toEmail} - Message ID: ${result.messageId}`);
		return true;
	} catch (error) {
		console.error(`❌ Failed to send email to ${toEmail}:`, error.message);
		return false;
	}
}

// Mark email as sent and save email body in database
async function markEmailAsSent(db, email, emailBody) {
	try {
		// Update email as sent and save the email body
		await runQuery(db, 'UPDATE emails SET email_sent = 1, email_body = ? WHERE email = ?', [emailBody, email]);
		console.log(`📝 Marked ${email} as sent and saved email body to database`);
	} catch (error) {
		console.error(`Error marking email as sent for ${email}:`, error.message);
	}
}

// Main function
async function main() {
	let db;

	try {
		console.log('🚀 Starting email sending process...');
		console.log(`📧 Target: ${EMAIL_COUNT} emails`);

		// Validate required environment variables
		if (!SMTP_USERNAME || !SMTP_PASSWORD) {
			throw new Error('SMTP_USERNAME and SMTP_PASSWORD environment variables are required');
		}
		if (!LLMGATEWAY_API_KEY) {
			throw new Error('LLMGATEWAY_API_KEY environment variable is required');
		}
		if (!GITHUB_TOKEN) {
			throw new Error('GITHUB_TOKEN environment variable is required');
		}

		// Initialize database connection
		db = await openDatabase(DB_PATH);
		console.log(`📁 Connected to database: ${DB_PATH}`);

		// Fetch emails to send
		const emailsToSend = await fetchEmailsToSend(db, EMAIL_COUNT);
		console.log(`📋 Found ${emailsToSend.length} emails to send`);

		if (emailsToSend.length === 0) {
			console.log('No emails to send. All available emails may have been sent already or flagged as ignore.');
			return;
		}

		// Initialize nodemailer transporter
		const transporter = createMailTransporter();

		// Verify SMTP connection
		try {
			await transporter.verify();
			console.log('📬 SMTP connection verified successfully');
		} catch (error) {
			throw new Error(`SMTP connection failed: ${error.message}`);
		}

		// Send emails
		let successCount = 0;
		let failureCount = 0;

		for (let i = 0; i < emailsToSend.length; i++) {
			const emailRecord = emailsToSend[i];
			const email = emailRecord.email;
			const repoName = emailRecord.repo_name;

			console.log(`\n[${i + 1}/${emailsToSend.length}] Processing: ${email} (${repoName})`);

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
			const personalizedEmail = generatePersonalizedEmail(repoAnalysis, repoInfo);

			// Send email
			console.log(`📧 Sending personalized email to ${email}...`);
			const success = await sendEmail(transporter, email, personalizedEmail);

			if (success) {
				await markEmailAsSent(db, email, personalizedEmail);
				successCount++;
			} else {
				failureCount++;
			}

			// Rate limiting - wait 2 seconds between emails (increased due to API calls)
			if (i < emailsToSend.length - 1) {
				console.log('⏳ Waiting 2 seconds...');
				await new Promise(resolve => setTimeout(resolve, 2000));
			}
		}

		// Summary
		console.log('\n=== EMAIL SENDING SUMMARY ===');
		console.log(`✅ Successfully sent: ${successCount}`);
		console.log(`❌ Failed to send: ${failureCount}`);
		console.log(`📊 Total processed: ${emailsToSend.length}`);

	} catch (error) {
		console.error('❌ Error in email sending process:', error.message);
		process.exit(1);
	} finally {
		// Close database connection
		if (db) {
			try {
				await closeDatabase(db);
				console.log('📁 Database connection closed');
			} catch (err) {
				console.error('Error closing database:', err.message);
			}
		}
	}
}

// Run the application
if (require.main === module) {
	main();
}

module.exports = { main };
