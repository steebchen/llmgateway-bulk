# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node.js application that searches GitHub repositories for contributors and stores their email addresses in an SQLite database. The application is designed to find developer contacts for bulk outreach purposes.

## Architecture

The codebase consists of a single main file (`send.js`) that:

1. **GitHub API Integration**: Searches repositories using the GitHub API with a configurable keyword
2. **SQLite Database**: Stores contributor emails with metadata (ignore flags, approval status, sent status)
3. **State Management**: Implements resumable operations by persisting request state in the database
4. **Rate Limiting**: Includes delays between API calls to respect GitHub rate limits

### Key Components

- **Database Schema**: Two tables - `emails` (contributor data) and `request_state` (resumable operation state)
- **Utility Functions**: Promisified SQLite operations for async/await pattern
- **GitHub API Client**: Fetches repositories and commit data with pagination support

## Development Commands

- **Run the application**: `node send.js`
- **Install dependencies**: `pnpm install` (uses pnpm as package manager)
- **No test suite**: Currently no tests are configured

## Configuration

The application uses hardcoded configuration constants at the top of `send.js`:

- `GITHUB_TOKEN`: GitHub Personal Access Token for API access
- `KEYWORD`: Search term for finding repositories
- `MAX_RESULTS`: Maximum number of repositories to process
- `COMMITS_PER_REPO`: Number of recent commits to fetch per repository

## Database

- SQLite database file: `contributor_emails.db` (ignored in git)
- Automatic schema creation on first run
- Supports resumable operations via state persistence

## Important Notes

- The application contains a hardcoded GitHub token that should be moved to environment variables
- Email addresses containing "noreply" are automatically flagged as ignored
- The database includes approval and sent tracking for email campaign management
- Rate limiting is implemented with 100-200ms delays between API calls