require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const nodemailer = require('nodemailer');

const MAILTRAP_API_KEY = process.env.MAILTRAP_API_KEY;
const EMAIL_COUNT = parseInt(process.env.EMAIL_COUNT) || 10;
const DB_PATH = process.env.DB_PATH ? path.join(__dirname, process.env.DB_PATH) : path.join(__dirname, 'contributor_emails.db');

// Email configuration
const FROM_EMAIL = process.env.FROM_EMAIL || 'sender@example.com';
const FROM_NAME = process.env.FROM_NAME || 'Bulk Outreach';
const EMAIL_SUBJECT = process.env.EMAIL_SUBJECT || 'Developer Outreach';
const EMAIL_BODY = process.env.EMAIL_BODY || `Hello,

I hope this email finds you well. I came across your work on GitHub and was impressed by your contributions to the developer community.

I'd love to connect and discuss potential collaboration opportunities.

Best regards,
${FROM_NAME}`;

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
	return nodemailer.createTransporter({
		host: 'send.api.mailtrap.io',
		port: 587,
		secure: false,
		auth: {
			user: 'api',
			pass: MAILTRAP_API_KEY
		}
	});
}

// Fetch unique email addresses from database
async function fetchEmailsToSend(db, count) {
	try {
		const query = `
			SELECT DISTINCT email
			FROM emails
			WHERE ignore = 0
			AND approved = 0
			AND email_sent = 0
			AND email NOT LIKE '%noreply%'
			AND email LIKE '%@%'
			ORDER BY created_at DESC
			LIMIT ?
		`;

		const emails = await allQuery(db, query, [count]);
		return emails.map(row => row.email);
	} catch (error) {
		console.error('Error fetching emails from database:', error.message);
		throw error;
	}
}

// Send email using nodemailer
async function sendEmail(transporter, toEmail) {
	try {
		const mailOptions = {
			from: {
				name: FROM_NAME,
				address: FROM_EMAIL
			},
			to: toEmail,
			subject: EMAIL_SUBJECT,
			text: EMAIL_BODY
		};

		const result = await transporter.sendMail(mailOptions);
		console.log(`✅ Email sent to ${toEmail} - Message ID: ${result.messageId}`);
		return true;
	} catch (error) {
		console.error(`❌ Failed to send email to ${toEmail}:`, error.message);
		return false;
	}
}

// Mark email as sent in database
async function markEmailAsSent(db, email) {
	try {
		await runQuery(db, 'UPDATE emails SET email_sent = 1 WHERE email = ?', [email]);
		console.log(`📝 Marked ${email} as sent in database`);
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
		if (!MAILTRAP_API_KEY) {
			throw new Error('MAILTRAP_API_KEY environment variable is required');
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
			const email = emailsToSend[i];
			console.log(`\n[${i + 1}/${emailsToSend.length}] Sending to: ${email}`);

			const success = await sendEmail(transporter, email);

			if (success) {
				await markEmailAsSent(db, email);
				successCount++;
			} else {
				failureCount++;
			}

			// Rate limiting - wait 1 second between emails
			if (i < emailsToSend.length - 1) {
				console.log('⏳ Waiting 1 second...');
				await new Promise(resolve => setTimeout(resolve, 1000));
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
