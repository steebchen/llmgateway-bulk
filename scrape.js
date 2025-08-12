require("dotenv").config();

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const KEYWORD = process.env.KEYWORD || "OPENROUTER";
const MAX_RESULTS = parseInt(process.env.MAX_RESULTS) || 100;
const PER_PAGE = 100; // GitHub API max per page
const COMMITS_PER_REPO = parseInt(process.env.COMMITS_PER_REPO) || 30;
const DB_PATH = process.env.DB_PATH ? path.join(__dirname, process.env.DB_PATH) : path.join(__dirname, "contributor_emails.db");

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

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

function getQuery(db, query, params = []) {
	return new Promise((resolve, reject) => {
		db.get(query, params, (err, row) => {
			if (err) {
				reject(err);
			} else {
				resolve(row);
			}
		});
	});
}

function prepareStatement(db, query) {
	return db.prepare(query);
}

function runStatement(stmt, params = []) {
	return new Promise((resolve, reject) => {
		stmt.run(...params, function (err) {
			if (err) {
				reject(err);
			} else {
				resolve(this);
			}
		});
	});
}

function finalizeStatement(stmt) {
	return new Promise((resolve, reject) => {
		stmt.finalize(err => {
			if (err) {
				reject(err);
			} else {
				resolve();
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

// Initialize SQLite database
let db;

async function initializeDatabase() {
	try {
		db = await openDatabase(DB_PATH);
		console.log(`Connected to SQLite database at ${DB_PATH}`);

		// Create emails table if it doesn't exist
		await runQuery(db, `
			CREATE TABLE IF NOT EXISTS emails
			(
				id
				INTEGER
				PRIMARY
				KEY
				AUTOINCREMENT,
				email
				TEXT
				UNIQUE,
				repo_name
				TEXT,
				keyword
				TEXT,
				ignore
				BOOLEAN,
				approved
				BOOLEAN
				DEFAULT
				0,
				sent
				BOOLEAN
				DEFAULT
				0,
				email_sent
				BOOLEAN
				DEFAULT
				0,
				email_follow_ups
				INTEGER
				DEFAULT
				0,
				created_at
				TIMESTAMP
				DEFAULT
				CURRENT_TIMESTAMP
			)
		`);


		// Add repo_name column if it doesn't exist (for existing databases)
		try {
			await runQuery(db, `ALTER TABLE emails
				ADD COLUMN repo_name TEXT`);
			console.log("Added repo_name column to existing emails table");
		} catch (err) {
			// Column already exists, ignore the error
			if (!err.message.includes("duplicate column name")) {
				throw err;
			}
		}

		// Add email_body column if it doesn't exist (for email tracking)
		try {
			await runQuery(db, `ALTER TABLE emails
				ADD COLUMN email_body TEXT`);
			console.log("Added email_body column to existing emails table");
		} catch (err) {
			// Column already exists, ignore the error
			if (!err.message.includes("duplicate column name")) {
				throw err;
			}
		}

		// Add keyword column if it doesn't exist (for existing databases)
		try {
			await runQuery(db, `ALTER TABLE emails
				ADD COLUMN keyword TEXT`);
			console.log("Added keyword column to existing emails table");
		} catch (err) {
			// Column already exists, ignore the error
			if (!err.message.includes("duplicate column name")) {
				throw err;
			}
		}

		// Add full_name column if it doesn't exist (for existing databases)
		try {
			await runQuery(db, `ALTER TABLE emails
				ADD COLUMN full_name TEXT`);
			console.log("Added full_name column to existing emails table");
		} catch (err) {
			// Column already exists, ignore the error
			if (!err.message.includes("duplicate column name")) {
				throw err;
			}
		}

		// Add github_stars column if it doesn't exist (for existing databases)
		try {
			await runQuery(db, `ALTER TABLE emails
				ADD COLUMN github_stars INTEGER`);
			console.log("Added github_stars column to existing emails table");
		} catch (err) {
			// Column already exists, ignore the error
			if (!err.message.includes("duplicate column name")) {
				throw err;
			}
		}

		// Add commits column if it doesn't exist (for existing databases)
		try {
			await runQuery(db, `ALTER TABLE emails
				ADD COLUMN commits INTEGER`);
			console.log("Added commits column to existing emails table");
		} catch (err) {
			// Column already exists, ignore the error
			if (!err.message.includes("duplicate column name")) {
				throw err;
			}
		}

		// Create state table to store the last request information
		await runQuery(db, `
			CREATE TABLE IF NOT EXISTS request_state
			(
				id
				INTEGER
				PRIMARY
				KEY
				CHECK
			(
				id =
				1
			),
				keyword TEXT,
				current_page INTEGER,
				date_range TEXT,
				date_segments TEXT,
				current_segment INTEGER DEFAULT 0,
				current_repo_index INTEGER DEFAULT 0,
				total_repos_found INTEGER DEFAULT 0,
				last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
				)
		`);

		console.log("Database initialized successfully");
	} catch (err) {
		console.error(`Error initializing database: ${err.message}`);
		process.exit(1);
	}
}

// Function to save email to database (only first occurrence)
async function saveEmail(email, repoName, keyword, fullName = null, githubStars = null, commits = null) {
	// Determine if email should be ignored (contains "noreply" or doesn't have @)
	const shouldIgnore = email.toLowerCase().includes("noreply") || !email.toLowerCase().includes("@");

	try {
		// Use INSERT OR IGNORE to prevent duplicate entries - only saves first occurrence
		const stmt = prepareStatement(db, "INSERT OR IGNORE INTO emails (email, repo_name, keyword, ignore, full_name, github_stars, commits) VALUES (?, ?, ?, ?, ?, ?, ?)");
		const result = await runStatement(stmt, [email, repoName, keyword, shouldIgnore ? 1 : 0, fullName, githubStars, commits]);
		await finalizeStatement(stmt);

		// result.changes tells us if a row was inserted (1) or not (0)
		if (result.changes === 0) {
			console.log(`  Email already exists in database: ${email}`);
		} else {
			// New email was inserted
			if (shouldIgnore) {
				console.log(`  Saved noreply email with ignore flag: ${email} (${fullName || email})`);
			} else {
				console.log(`  Saved email: ${email} (${fullName || email}) - ${githubStars || 0} stars, ${commits || 0} commits`);
			}
		}
	} catch (error) {
		console.error(`  Error saving email ${email}: ${error.message}`);
	}
}

// Function to get saved state from database
async function getSavedState() {
	try {
		const state = await getQuery(db, "SELECT keyword, current_page, date_range, date_segments, current_segment, current_repo_index, total_repos_found FROM request_state WHERE id = 1");
		if (state && state.date_range) {
			state.date_range = JSON.parse(state.date_range);
		}
		if (state && state.date_segments) {
			state.date_segments = JSON.parse(state.date_segments);
		}
		return state;
	} catch (err) {
		console.error(`Error getting saved state: ${err.message}`);
		return null;
	}
}

// Function to save current state to database with date range support
async function saveState(keyword, page, dateRange = null) {
	try {
		await runQuery(
			db,
			"INSERT OR REPLACE INTO request_state (id, keyword, current_page, date_range, last_updated) VALUES (1, ?, ?, ?, CURRENT_TIMESTAMP)",
			[keyword, page, dateRange ? JSON.stringify(dateRange) : null],
		);
		console.log(`Saved state: keyword=${keyword}, page=${page}${dateRange ? `, dateRange=${dateRange.start} to ${dateRange.end}` : ""}`);
	} catch (err) {
		console.error(`Error saving state: ${err.message}`);
		throw err;
	}
}

// Function to save detailed processing state
async function saveProcessingState(keyword, segments, currentSegment, currentRepoIndex, totalReposFound) {
	try {
		await runQuery(
			db,
			"INSERT OR REPLACE INTO request_state (id, keyword, current_page, date_segments, current_segment, current_repo_index, total_repos_found, last_updated) VALUES (1, ?, 1, ?, ?, ?, ?, CURRENT_TIMESTAMP)",
			[keyword, JSON.stringify(segments), currentSegment, currentRepoIndex, totalReposFound],
		);
		console.log(`💾 State saved: segment ${currentSegment + 1}/${segments.length}, repo ${currentRepoIndex}/${totalReposFound}`);
	} catch (err) {
		console.error(`Error saving processing state: ${err.message}`);
		throw err;
	}
}

// Function to check if a repository has already been processed
async function isRepoProcessed(repoName) {
	try {
		const result = await getQuery(db, "SELECT COUNT(*) as count FROM emails WHERE repo_name = ?", [repoName]);
		return result.count > 0;
	} catch (err) {
		console.error(`Error checking if repo is processed: ${err.message}`);
		return false;
	}
}

// Generate date segments to bypass GitHub's 1000 result limit
function generateDateSegments(startDate, endDate, segmentDays = 30) {
	const segments = [];
	const current = new Date(startDate);
	const end = new Date(endDate);

	while (current <= end) {
		const segmentEnd = new Date(current);
		segmentEnd.setDate(segmentEnd.getDate() + segmentDays - 1);

		if (segmentEnd > end) {
			segmentEnd.setTime(end.getTime());
		}

		segments.push({
			start: current.toISOString().split("T")[0],
			end: segmentEnd.toISOString().split("T")[0],
		});

		current.setDate(current.getDate() + segmentDays);
	}

	return segments;
}

// Search repositories within a specific date range
async function searchRepositoriesInDateRange(keyword, dateRange) {
	const dateQuery = `created:${dateRange.start}..${dateRange.end}`;
	const searchQuery = `${keyword} ${dateQuery}`;
	const baseUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(searchQuery)}`;
	const headers = {
		"Accept": "application/vnd.github+json",
		"Authorization": `Bearer ${GITHUB_TOKEN}`,
	};

	let allRepos = [];
	let page = 1;
	let hasMoreResults = true;
	let totalCount = 0;

	try {
		// Get total count from first page
		const initialUrl = `${baseUrl}&per_page=${PER_PAGE}&page=1`;
		const initialResponse = await fetch(initialUrl, { headers });
		if (!initialResponse.ok) {
			throw new Error(`GitHub API error: ${initialResponse.status} ${initialResponse.statusText}`);
		}
		const initialData = await initialResponse.json();
		totalCount = initialData.total_count;

		console.log(`  Date range ${dateRange.start} to ${dateRange.end}: ${totalCount} repositories`);

		// If more than 1000 results, we need to split this range further
		if (totalCount > 1000) {
			console.log(`  ⚠️  Range has ${totalCount} results (>1000), needs further segmentation`);
			return { repos: [], needsSplit: true, totalCount };
		}

		// Process all pages for this date range
		allRepos.push(...initialData.items);
		hasMoreResults = initialData.items.length === PER_PAGE;
		page++;

		if (hasMoreResults) {
			await sleep(500);
		}

		while (hasMoreResults && page <= 10) {
			const url = `${baseUrl}&per_page=${PER_PAGE}&page=${page}`;

			const response = await fetch(url, { headers });
			if (!response.ok) {
				throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();
			allRepos.push(...data.items);

			hasMoreResults = data.items.length === PER_PAGE;
			page++;

			if (hasMoreResults) {
				await sleep(500);
			}
		}

		return { repos: allRepos, needsSplit: false, totalCount };

	} catch (error) {
		console.error(`Error searching date range ${dateRange.start} to ${dateRange.end}:`, error.message);
		return { repos: [], needsSplit: false, totalCount: 0 };
	}
}

// Enhanced version that also provides commit statistics with date segmentation
async function searchRepositoriesWithStats(keyword) {
	let allRepos = [];
	let dateSegments = [];
	let currentSegment = 0;

	// Check for saved state
	const savedState = await getSavedState();
	let resumingRepoIndex = 0;
	if (savedState && savedState.keyword === keyword) {
		if (savedState.date_segments) {
			dateSegments = savedState.date_segments;
			currentSegment = savedState.current_segment || 0;
			resumingRepoIndex = savedState.current_repo_index || 0;
			console.log(`🔄 Resuming from segment ${currentSegment + 1} of ${dateSegments.length}, repo ${resumingRepoIndex} for keyword "${keyword}"`);
		} else {
			console.log("Found old state format, starting fresh with date segmentation");
			await runQuery(db, "DELETE FROM request_state WHERE id = 1");
		}
	}

	try {
		// Generate date segments if not resuming
		if (dateSegments.length === 0) {
			console.log("🗓️  Generating date segments to bypass GitHub's 1000 result limit...");

			// Start from a later date
			const startDate = new Date("2024-01-01");
			const endDate = new Date();

			// Start with 1-month segments for more recent data
			dateSegments = generateDateSegments(startDate, endDate, 30);
			console.log(`Generated ${dateSegments.length} date segments (1-month periods from Nov 2022)`);

			// Save initial state
			await runQuery(
				db,
				"INSERT OR REPLACE INTO request_state (id, keyword, current_page, date_segments, current_segment, last_updated) VALUES (1, ?, 1, ?, 0, CURRENT_TIMESTAMP)",
				[keyword, JSON.stringify(dateSegments)],
			);
		}

		const contributorStats = new Map(); // email -> { count, repos, lastCommitDate }
		const seenRepos = new Set(); // Track processed repos to avoid duplicates
		let totalReposProcessed = 0;

		// Define headers for commit fetching
		const headers = {
			"Accept": "application/vnd.github+json",
			"Authorization": `Bearer ${GITHUB_TOKEN}`,
		};

		// Process repositories in batches as we find them
		async function processBatchOfRepos(repos, segmentInfo) {
			console.log(`\n🔄 Processing batch of ${repos.length} repositories from ${segmentInfo}`);

			for (let repoIndex = 0; repoIndex < repos.length; repoIndex++) {
				const repo = repos[repoIndex];

				// Skip duplicates
				if (seenRepos.has(repo.full_name)) {
					continue;
				}
				seenRepos.add(repo.full_name);

				// Check if this repository has already been processed
				const alreadyProcessed = await isRepoProcessed(repo.full_name);
				if (alreadyProcessed) {
					console.log(`  Skipping ${repo.full_name} (already processed)`);
					continue;
				}

				totalReposProcessed++;

				// Rate limiting before API call
				await sleep(1000);
				console.log(`  [${totalReposProcessed}] Fetching commits for ${repo.full_name}...`);

				try {
					const commitsUrl = `https://api.github.com/repos/${repo.full_name}/commits?per_page=${COMMITS_PER_REPO}`;
					const commitsResponse = await fetch(commitsUrl, { headers });

					if (!commitsResponse.ok) {
						console.log(`    Skipping ${repo.full_name} (${commitsResponse.status})`);
						continue;
					}

					const commits = await commitsResponse.json();

					// First pass: count commits per contributor
					const repoContributors = new Map(); // email -> { count, fullName, lastCommitDate }

					for (const commit of commits) {
						if (commit.commit && commit.commit.author && commit.commit.author.email) {
							const email = commit.commit.author.email;
							const commitDate = new Date(commit.commit.author.date);
							const fullName = commit.commit.author.name || email;

							if (!repoContributors.has(email)) {
								repoContributors.set(email, {
									count: 0,
									fullName: fullName,
									lastCommitDate: commitDate,
								});
							}

							const repoStats = repoContributors.get(email);
							repoStats.count++;
							if (commitDate > repoStats.lastCommitDate) {
								repoStats.lastCommitDate = commitDate;
							}
						}
					}

					// Second pass: save emails with commit counts
					for (const [email, repoStats] of repoContributors) {
						// Save to database immediately when first encountered
						if (!contributorStats.has(email)) {
							contributorStats.set(email, {
								count: 0,
								repos: new Set(),
								lastCommitDate: repoStats.lastCommitDate,
								fullName: repoStats.fullName,
								isNoreply: email.toLowerCase().includes("noreply") || !email.toLowerCase().includes("@"),
							});

							// Save to database immediately with full name, GitHub stars, and commit count
							await saveEmail(email, repo.full_name, keyword, repoStats.fullName, repo.stargazers_count, repoStats.count);
						}

						const stats = contributorStats.get(email);
						stats.count += repoStats.count;
						stats.repos.add(repo.full_name);

						if (repoStats.lastCommitDate > stats.lastCommitDate) {
							stats.lastCommitDate = repoStats.lastCommitDate;
						}
					}

					console.log(`    Found ${commits.length} commits`);

				} catch (error) {
					console.log(`    Error fetching commits for ${repo.full_name}: ${error.message}`);
				}

				await sleep(200); // Brief pause between repos

				// Check if we've reached MAX_RESULTS
				if (totalReposProcessed >= MAX_RESULTS) {
					console.log(`\n✅ Reached MAX_RESULTS limit of ${MAX_RESULTS} repositories`);
					return true; // Signal to stop processing
				}
			}
			return false; // Continue processing
		}

		// Process each date segment and its repositories immediately
		for (let i = currentSegment; i < dateSegments.length; i++) {
			const segment = dateSegments[i];
			console.log(`\n📅 Processing segment ${i + 1}/${dateSegments.length}: ${segment.start} to ${segment.end}`);

			const result = await searchRepositoriesInDateRange(keyword, segment);

			if (result.needsSplit) {
				// Split this segment into smaller chunks (1 month)
				console.log(`  🔄 Splitting segment into smaller chunks...`);
				const subSegments = generateDateSegments(new Date(segment.start), new Date(segment.end), 30);

				for (const subSegment of subSegments) {
					console.log(`  📅 Processing sub-segment: ${subSegment.start} to ${subSegment.end}`);
					const subResult = await searchRepositoriesInDateRange(keyword, subSegment);

					if (subResult.needsSplit) {
						// Split further into weekly chunks
						console.log(`    🔄 Sub-segment still too large, splitting into weeks...`);
						const weeklySegments = generateDateSegments(new Date(subSegment.start), new Date(subSegment.end), 7);

						for (const weekSegment of weeklySegments) {
							console.log(`    📅 Processing weekly segment: ${weekSegment.start} to ${weekSegment.end}`);
							const weekResult = await searchRepositoriesInDateRange(keyword, weekSegment);
							const shouldStop = await processBatchOfRepos(weekResult.repos, `weekly segment ${weekSegment.start} to ${weekSegment.end}`);
							if (shouldStop) break;
							await sleep(500); // Rate limiting
						}
					} else {
						const shouldStop = await processBatchOfRepos(subResult.repos, `sub-segment ${subSegment.start} to ${subSegment.end}`);
						if (shouldStop) break;
					}
					await sleep(500); // Rate limiting
					if (totalReposProcessed >= MAX_RESULTS) break;
				}
			} else {
				const shouldStop = await processBatchOfRepos(result.repos, `segment ${segment.start} to ${segment.end}`);
				if (shouldStop) break;
			}

			// Update progress
			await runQuery(
				db,
				"UPDATE request_state SET current_segment = ?, last_updated = CURRENT_TIMESTAMP WHERE id = 1",
				[i + 1],
			);

			await sleep(1000); // Increased rate limiting between segments

			// Check if we've reached MAX_RESULTS
			if (totalReposProcessed >= MAX_RESULTS) {
				console.log(`\n✅ Reached MAX_RESULTS limit of ${MAX_RESULTS} repositories`);
				break;
			}
		}

		// Display detailed results
		console.log(`\n=== CONTRIBUTOR STATISTICS ===`);
		console.log(`Total repositories processed: ${totalReposProcessed}`);
		console.log(`Total unique contributors: ${contributorStats.size}`);
		console.log(`Emails saved to SQLite database: ${DB_PATH}`);

		// Sort by commit count (most active first)
		const sortedContributors = Array.from(contributorStats.entries())
			.sort((a, b) => b[1].count - a[1].count);

		console.log(`\nTop contributors by commit count:`);
		sortedContributors.forEach(([email, stats], index) => {
			console.log(`${index + 1}. ${stats.fullName || email} (${email})${stats.isNoreply ? " [NOREPLY]" : ""}`);
			console.log(`   Commits: ${stats.count}`);
			console.log(`   Repositories: ${stats.repos.size}`);
			console.log(`   Last commit: ${stats.lastCommitDate.toISOString().split("T")[0]}`);
			console.log(`   Ignore flag: ${stats.isNoreply ? "Yes" : "No"}`);
			console.log("");
		});

		// Delete state after successful completion (all segments processed)
		await runQuery(db, "DELETE FROM request_state WHERE id = 1");
		console.log("✅ Processing complete. State cleared - all date segments processed.");

		return sortedContributors.map(([email]) => email);

	} catch (error) {
		console.error("Error fetching data:", error.message);
		// Save current state to allow resuming from this point
		if (currentSegment > 0 || totalReposProcessed > 0) {
			await saveProcessingState(keyword, dateSegments || [], currentSegment, totalReposProcessed, totalReposProcessed);
			console.log(`❌ Error occurred. State saved at segment ${currentSegment + 1}, processed ${totalReposProcessed} repositories for resuming later.`);
		}
	}
}

// Function to backfill commit counts for existing emails
async function backfillCommitCounts() {
	try {
		console.log("🔄 Starting backfill of commit counts for existing emails...");

		// Get all emails that don't have commit counts and are not ignored
		const emailsToBackfill = await new Promise((resolve, reject) => {
			db.all("SELECT email, repo_name FROM emails WHERE commits IS NULL AND ignore = 0", (err, rows) => {
				if (err) {
					reject(err);
				} else {
					resolve(rows);
				}
			});
		});

		if (emailsToBackfill.length === 0) {
			console.log("✅ No emails need backfilling");
			return;
		}

		console.log(`Found ${emailsToBackfill.length} emails to backfill`);

		const headers = {
			"Accept": "application/vnd.github+json",
			"Authorization": `Bearer ${GITHUB_TOKEN}`,
		};

		const emailCommitCounts = new Map(); // email -> total commits across all repos

		// Group by repo to minimize API calls
		const repoEmails = new Map();
		for (const row of emailsToBackfill) {
			if (!repoEmails.has(row.repo_name)) {
				repoEmails.set(row.repo_name, new Set());
			}
			repoEmails.get(row.repo_name).add(row.email);
		}

		let processedRepos = 0;
		for (const [repoName, emails] of repoEmails) {
			processedRepos++;
			console.log(`[${processedRepos}/${repoEmails.size}] Processing ${repoName}...`);

			try {
				// Rate limiting
				await sleep(1000);

				const commitsUrl = `https://api.github.com/repos/${repoName}/commits?per_page=${COMMITS_PER_REPO}`;
				const commitsResponse = await fetch(commitsUrl, { headers });

				if (!commitsResponse.ok) {
					console.log(`  Skipping ${repoName} (${commitsResponse.status})`);
					continue;
				}

				const commits = await commitsResponse.json();
				const repoCommitCounts = new Map(); // email -> commit count in this repo

				// Count commits per contributor in this repo
				for (const commit of commits) {
					if (commit.commit && commit.commit.author && commit.commit.author.email) {
						const email = commit.commit.author.email;
						if (emails.has(email)) {
							repoCommitCounts.set(email, (repoCommitCounts.get(email) || 0) + 1);
						}
					}
				}

				// Update database for each email in this repo
				for (const [email, commitCount] of repoCommitCounts) {
					console.log(`  Updating ${email}: ${commitCount} commits`);
					await runQuery(db, "UPDATE emails SET commits = ? WHERE email = ? AND repo_name = ?", [commitCount, email, repoName]);
				}

				console.log(`  Found commits for ${repoCommitCounts.size} contributors`);

			} catch (error) {
				console.log(`  Error processing ${repoName}: ${error.message}`);
			}
		}

		console.log("✅ Backfill complete");

	} catch (error) {
		console.error("Error during backfill:", error.message);
		throw error;
	}
}

// Main function to run the application
async function main() {
	try {
		// Check if backfill flag is provided
		const isBackfill = process.argv.includes('--backfill');

		if (isBackfill) {
			console.log("Starting commit count backfill...");
		} else {
			console.log("Starting contributor analysis...");
		}

		// Initialize database first
		await initializeDatabase();

		if (isBackfill) {
			// Run backfill instead of normal scraping
			await backfillCommitCounts();
			process.exit(0);
		} else {
			// Then run the search
			await searchRepositoriesWithStats(KEYWORD);
		}

		// Close the database connection when done
		console.log("Closing database connection...");
		await closeDatabase(db);
		console.log("Database connection closed");
	} catch (error) {
		console.error("Error in main process:", error);
		// Ensure database is closed even on error
		try {
			if (db) {
				await closeDatabase(db);
			}
		} catch (err) {
			console.error(`Error closing database: ${err.message}`);
		}
		process.exit(1);
	}
}

// Run the application
main();
