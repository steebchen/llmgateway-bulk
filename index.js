require('dotenv').config();

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const KEYWORD = process.env.KEYWORD || 'OPENROUTER';
const MAX_RESULTS = parseInt(process.env.MAX_RESULTS) || 100;
const PER_PAGE = 100; // GitHub API max per page
const COMMITS_PER_REPO = parseInt(process.env.COMMITS_PER_REPO) || 30;
const DB_PATH = process.env.DB_PATH ? path.join(__dirname, process.env.DB_PATH) : path.join(__dirname, 'contributor_emails.db');

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
		db.run(query, params, function(err) {
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
		stmt.run(...params, function(err) {
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
			CREATE TABLE IF NOT EXISTS emails (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				email TEXT UNIQUE,
				repo_name TEXT,
				ignore BOOLEAN,
				approved BOOLEAN DEFAULT 0,
				sent BOOLEAN DEFAULT 0,
				email_sent BOOLEAN DEFAULT 0,
				email_follow_ups INTEGER DEFAULT 0,
				created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

		// Add repo_name column if it doesn't exist (for existing databases)
		try {
			await runQuery(db, `ALTER TABLE emails ADD COLUMN repo_name TEXT`);
			console.log('Added repo_name column to existing emails table');
		} catch (err) {
			// Column already exists, ignore the error
			if (!err.message.includes('duplicate column name')) {
				throw err;
			}
		}

		// Create state table to store the last request information
		await runQuery(db, `
			CREATE TABLE IF NOT EXISTS request_state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				keyword TEXT,
				current_page INTEGER,
				last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
			)
		`);

		console.log('Database initialized successfully');
	} catch (err) {
		console.error(`Error initializing database: ${err.message}`);
		process.exit(1);
	}
}

// Function to save email to database
async function saveEmail(email, repoName) {
	// Determine if email should be ignored (contains "noreply" or doesn't have @)
	const shouldIgnore = email.toLowerCase().includes('noreply') || !email.toLowerCase().includes('@');

	try {
		// Use INSERT OR IGNORE to prevent duplicate entries
		// This is more efficient than checking first and then inserting
		const stmt = prepareStatement(db, 'INSERT OR IGNORE INTO emails (email, repo_name, ignore) VALUES (?, ?, ?)');
		const result = await runStatement(stmt, [email, repoName, shouldIgnore ? 1 : 0]);

		// result.changes tells us if a row was inserted (1) or not (0)
		if (result.changes === 0) {
			console.log(`  Email already exists in database: ${email}`);
		} else {
			if (shouldIgnore) {
				console.log(`  Saved noreply email with ignore flag: ${email}`);
			} else {
				console.log(`  Saved email: ${email}`);
			}
		}

		await finalizeStatement(stmt);
	} catch (error) {
		console.error(`  Error saving email ${email}: ${error.message}`);
	}
}

// Function to get saved state from database
async function getSavedState() {
	try {
		return await getQuery(db, 'SELECT keyword, current_page FROM request_state WHERE id = 1');
	} catch (err) {
		console.error(`Error getting saved state: ${err.message}`);
		return null;
	}
}

// Function to save current state to database
async function saveState(keyword, page) {
	try {
		await runQuery(
			db,
			'INSERT OR REPLACE INTO request_state (id, keyword, current_page, last_updated) VALUES (1, ?, ?, CURRENT_TIMESTAMP)',
			[keyword, page]
		);
		console.log(`Saved state: keyword=${keyword}, page=${page}`);
	} catch (err) {
		console.error(`Error saving state: ${err.message}`);
		throw err;
	}
}

// Function to check if a repository has already been processed
async function isRepoProcessed(repoName) {
	try {
		const result = await getQuery(db, 'SELECT COUNT(*) as count FROM emails WHERE repo_name = ?', [repoName]);
		return result.count > 0;
	} catch (err) {
		console.error(`Error checking if repo is processed: ${err.message}`);
		return false;
	}
}

// Enhanced version that also provides commit statistics
async function searchRepositoriesWithStats(keyword) {
	const baseUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(keyword)}`;
	const headers = {
		'Accept': 'application/vnd.github+json',
		'Authorization': `Bearer ${GITHUB_TOKEN}`
	};

	let allRepos = [];
	let page = 1;
	let hasMoreResults = true;

	// Check for saved state
	const savedState = await getSavedState();
	if (savedState && savedState.keyword === keyword) {
		page = savedState.current_page;
		console.log(`Resuming from page ${page} for keyword "${keyword}"`);
	}


	try {
		while (hasMoreResults && allRepos.length < MAX_RESULTS) {
			const url = `${baseUrl}&per_page=${PER_PAGE}&page=${page}`;
			console.log(`Fetching repositories page ${page}...`);

			const response = await fetch(url, { headers });
			if (!response.ok) {
				throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
			}

			const data = await response.json();
			const remainingSlots = MAX_RESULTS - allRepos.length;
			const reposToAdd = data.items.slice(0, remainingSlots);
			allRepos.push(...reposToAdd);

			hasMoreResults = data.items.length === PER_PAGE && allRepos.length < MAX_RESULTS;

			page++;

			// Save current state after moving to next page
			await saveState(keyword, page);

			if (hasMoreResults) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}

		console.log(`\nFound ${allRepos.length} repositories`);

		const contributorStats = new Map(); // email -> { count, repos, lastCommitDate }

		for (const repo of allRepos) {
			await sleep(1000);

			// Check if this repository has already been processed
			const alreadyProcessed = await isRepoProcessed(repo.full_name);
			if (alreadyProcessed) {
				console.log(`Skipping ${repo.full_name} (already processed)`);
				continue;
			}

			console.log(`Fetching commits for ${repo.full_name}...`);

			try {
				const commitsUrl = `https://api.github.com/repos/${repo.full_name}/commits?per_page=${COMMITS_PER_REPO}`;
				const commitsResponse = await fetch(commitsUrl, { headers });

				if (!commitsResponse.ok) {
					console.log(`  Skipping ${repo.full_name} (${commitsResponse.status})`);
					continue;
				}

				const commits = await commitsResponse.json();

				// Collect contributor statistics
				commits.forEach(commit => {
					if (commit.commit && commit.commit.author && commit.commit.author.email) {
						const email = commit.commit.author.email;
						const commitDate = new Date(commit.commit.author.date);

						// Include all emails in stats, even noreply ones
						if (!contributorStats.has(email)) {
							contributorStats.set(email, {
								count: 0,
								repos: new Set(),
								lastCommitDate: commitDate,
								isNoreply: email.toLowerCase().includes('noreply') || !email.toLowerCase().includes('@')
							});

							// Save to database when first encountered
							// This will handle duplicate prevention internally
							// We don't need to await this since we don't need to wait for each email to be saved
							// before processing the next one, and the function handles errors internally
							saveEmail(email, repo.full_name);
						}

						const stats = contributorStats.get(email);
						stats.count++;
						stats.repos.add(repo.full_name);

						if (commitDate > stats.lastCommitDate) {
							stats.lastCommitDate = commitDate;
						}
					}
				});

				console.log(`  Found ${commits.length} commits`);

			} catch (error) {
				console.log(`  Error fetching commits for ${repo.full_name}: ${error.message}`);
			}

			await new Promise(resolve => setTimeout(resolve, 200));
		}

		// Display detailed results
		console.log(`\n=== CONTRIBUTOR STATISTICS ===`);
		console.log(`Total unique contributors: ${contributorStats.size}`);
		console.log(`Emails saved to SQLite database: ${DB_PATH}`);

		// Sort by commit count (most active first)
		const sortedContributors = Array.from(contributorStats.entries())
			.sort((a, b) => b[1].count - a[1].count);

		console.log(`\nTop contributors by commit count:`);
		sortedContributors.forEach(([email, stats], index) => {
			console.log(`${index + 1}. ${email}${stats.isNoreply ? ' [NOREPLY]' : ''}`);
			console.log(`   Commits: ${stats.count}`);
			console.log(`   Repositories: ${stats.repos.size}`);
			console.log(`   Last commit: ${stats.lastCommitDate.toISOString().split('T')[0]}`);
			console.log(`   Ignore flag: ${stats.isNoreply ? 'Yes' : 'No'}`);
			console.log('');
		});

		// Reset state to page 1 after successful completion
		await saveState(keyword, 1);
		console.log('Processing complete. State reset to page 1 for next run.');

		return sortedContributors.map(([email]) => email);

	} catch (error) {
		console.error('Error fetching data:', error.message);
		// Save current state to allow resuming from this point
		if (page > 1) {
			await saveState(keyword, page);
			console.log(`Error occurred. State saved at page ${page} for resuming later.`);
		}
	}
}

// Main function to run the application
async function main() {
	try {
		console.log('Starting contributor analysis...');

		// Initialize database first
		await initializeDatabase();

		// Then run the search
		await searchRepositoriesWithStats(KEYWORD);

		// Close the database connection when done
		console.log('Closing database connection...');
		await closeDatabase(db);
		console.log('Database connection closed');
	} catch (error) {
		console.error('Error in main process:', error);
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
