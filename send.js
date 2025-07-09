const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const GITHUB_TOKEN = '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'; // Replace with your token
const KEYWORD = 'OPENROUTER'; // Replace with your keyword
const MAX_RESULTS = 100;
const PER_PAGE = 100; // GitHub API max per page
const COMMITS_PER_REPO = 30; // Number of recent commits to fetch per repository
const DB_PATH = path.join(__dirname, 'contributor_emails.db'); // Path to SQLite database

// Initialize SQLite database
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error(`Error opening database: ${err.message}`);
        process.exit(1);
    }
    console.log(`Connected to SQLite database at ${DB_PATH}`);

    // Create emails table if it doesn't exist
    db.run(`
        CREATE TABLE IF NOT EXISTS emails (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT UNIQUE,
            ignore BOOLEAN,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `, (err) => {
        if (err) {
            console.error(`Error creating table: ${err.message}`);
            process.exit(1);
        }
        console.log('Database initialized successfully');
    });
});

// Function to save email to database
function saveEmail(email) {
    // Determine if email should be ignored (contains "noreply" or doesn't have @)
    const shouldIgnore = email.toLowerCase().includes('noreply') || !email.toLowerCase().includes('@');

    try {
        // Use INSERT OR IGNORE to prevent duplicate entries
        // This is more efficient than checking first and then inserting
        const stmt = db.prepare('INSERT OR IGNORE INTO emails (email, ignore) VALUES (?, ?)');
        stmt.run(email, shouldIgnore ? 1 : 0, function(err) {
            if (err) {
                console.error(`  Error saving email ${email}: ${err.message}`);
                return;
            }

            // this.changes tells us if a row was inserted (1) or not (0)
            if (this.changes === 0) {
                console.log(`  Email already exists in database: ${email}`);
            } else {
                if (shouldIgnore) {
                    console.log(`  Saved noreply email with ignore flag: ${email}`);
                } else {
                    console.log(`  Saved email: ${email}`);
                }
            }
        });
        stmt.finalize();
    } catch (error) {
        console.error(`  Error saving email ${email}: ${error.message}`);
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

			if (hasMoreResults) {
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}

		console.log(`\nFound ${allRepos.length} repositories`);

		const contributorStats = new Map(); // email -> { count, repos, lastCommitDate }

		for (const repo of allRepos) {
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
							saveEmail(email);
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

		return sortedContributors.map(([email]) => email);

	} catch (error) {
		console.error('Error fetching data:', error.message);
	}
}

// Run the enhanced version
console.log('Starting contributor analysis...');
searchRepositoriesWithStats(KEYWORD)
    .then(() => {
        // Close the database connection when done
        console.log('Closing database connection...');
        db.close((err) => {
            if (err) {
                console.error(`Error closing database: ${err.message}`);
                process.exit(1);
            }
            console.log('Database connection closed');
        });
    })
    .catch(error => {
        console.error('Error in main process:', error);
        // Ensure database is closed even on error
        db.close();
    });
