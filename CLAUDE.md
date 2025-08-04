# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node.js application designed for developer outreach, consisting of two main components:

1. **Repository Scraper** (`scrape.js`): Searches GitHub repositories for contributors and stores their email addresses in an SQLite database
2. **Email Sender** (`email.js`): Sends personalized outreach emails using AI-generated content based on repository analysis

## Architecture

The application follows a two-phase approach:

### Phase 1: Data Collection (`scrape.js`)
- **GitHub API Integration**: Searches repositories using configurable keywords with date segmentation to bypass API limits
- **State Management**: Implements resumable operations by persisting request state in the database
- **Rate Limiting**: Includes delays between API calls to respect GitHub rate limits
- **Email Extraction**: Collects contributor emails from commit history

### Phase 2: Email Outreach (`email.js`)
- **Repository Analysis**: Uses LLMGateway API to analyze repositories and generate personalized descriptions
- **Email Generation**: Creates tailored outreach emails based on AI analysis
- **SMTP Integration**: Sends emails via Mailtrap SMTP service
- **Campaign Tracking**: Tracks sent emails and campaign status in database

### Key Components

- **Database Schema**: Two tables - `emails` (contributor data with campaign tracking) and `request_state` (resumable operation state)
- **Utility Functions**: Promisified SQLite operations for async/await pattern
- **GitHub API Client**: Fetches repositories and commit data with pagination support
- **AI Analysis**: LLMGateway integration for repository content analysis
- **Email Service**: Nodemailer integration for SMTP email delivery

## Development Commands

- **Run repository scraper**: `node scrape.js`
- **Run email sender**: `node email.js`
- **Install dependencies**: `pnpm install` (uses pnpm as package manager)
- **No test suite**: Currently no tests are configured

## Configuration

The application uses environment variables (loaded via dotenv):

### Required Environment Variables
- `GITHUB_TOKEN`: GitHub Personal Access Token for API access
- `SMTP_USERNAME`: Mailtrap SMTP username
- `SMTP_PASSWORD`: Mailtrap SMTP password
- `LLMGATEWAY_API_KEY`: LLMGateway API key for repository analysis

### Optional Environment Variables
- `KEYWORD`: Search term for finding repositories (default: 'OPENROUTER')
- `MAX_RESULTS`: Maximum number of repositories to process (default: 100)
- `COMMITS_PER_REPO`: Number of recent commits to fetch per repository (default: 30)
- `EMAIL_COUNT`: Number of emails to send per run (default: 10)
- `DB_PATH`: Custom database path (default: 'contributor_emails.db')
- `FROM_EMAIL`: Email sender address (default: 'hello@llmgateway.io')
- `FROM_NAME`: Email sender name (default: 'LLMGateway Team')
- `EMAIL_SUBJECT`: Email subject line

## Database

- SQLite database file: `contributor_emails.db` (ignored in git)
- Automatic schema creation and migration on first run
- Supports resumable operations via state persistence
- Extended schema includes email campaign tracking (`email_sent`, `email_body`, `approved`)

## Workflow

1. **Data Collection**: Run `scrape.js` to collect contributor emails from GitHub repositories
2. **Email Campaign**: Run `email.js` to send personalized outreach emails to collected contributors
3. **State Management**: Both scripts support resumable operations and can be safely interrupted and restarted

## Important Notes

- The scraper implements date segmentation to bypass GitHub's 1000 result limit per search
- Email addresses containing "noreply" are automatically flagged as ignored
- Repository analysis uses AI to generate personalized email content
- Rate limiting is implemented throughout to respect API limits
- Campaign tracking prevents duplicate emails to the same recipient
