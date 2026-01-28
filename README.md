# WTAP Scraper

A TypeScript-based web scraper that downloads "Mental Health Mondays" episodes from the WTAP news website.

## Features

- Searches for "Mental Health Mondays" episodes on the WTAP website
- Extracts embedded video URLs from article pages
- Downloads videos in MP4 format
- Stores videos in a `.data` directory
- Checks for existing files to avoid re-downloading

## Installation

```bash
pnpm install
```

## Usage

Run the scraper:

```bash
pnpm run scrape
```

The scraper will:

1. Visit the search results page for "Mental Health Mondays"
2. Find all matching episode pages
3. Extract video URLs from each page
4. Download videos to the `.data` directory if they don't already exist

## How It Works

### Search Phase

- Uses Puppeteer to render the JavaScript-heavy search page
- Finds links matching the "Mental Health Mondays, Ep. N" pattern
- Collects URLs and titles

### Video Extraction

- Fetches each episode page
- Extracts video data from the page's Fusion JSON metadata
- Prioritizes MP4 streams for best compatibility
- Falls back to HLS streams if needed

### Download Phase

- Checks if file already exists to avoid duplicates
- Downloads videos using streaming to handle large files efficiently
- Saves with episode numbers in filename (e.g., `Mental-Health-Mondays-Ep1.mp4`)

## File Structure

```
.
├── src/
│   └── scraper.ts          # Main scraper script
├── .data/                   # Downloaded videos (gitignored)
├── package.json
├── tsconfig.json
└── eslint.config.ts
```

## Dependencies

- **axios**: HTTP client for fetching pages
- **cheerio**: HTML parsing
- **puppeteer**: Headless browser for JavaScript rendering
- **tsx**: TypeScript execution

## Environment

- Node.js 18+
- Works on macOS, Linux, and Windows
