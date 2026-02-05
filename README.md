# WTAP Scraper

A TypeScript-based web scraper that downloads "Mental Health Mondays" episodes from the WTAP news website and generates a podcast-ready RSS feed.

## Features

- Searches for "Mental Health Mondays" episodes on the WTAP website
- Extracts embedded video URLs from article pages
- Downloads videos in MP4 format
- Stores videos in a `.data` directory
- Checks for existing files to avoid re-downloading
- Extracts and tags MP3 audio into `.data/mp3/` (customizable)
- Generates an RSS XML file in `.data/` for use in podcast players (file name customizable)

## Installation

```bash
pnpm install
```

## Usage

Run the scraper locally:

```bash
pnpm run scrape
```

The scraper will:

1. Visit the search results page for "Mental Health Mondays"
2. Find all matching episode pages
3. Extract video URLs from each page
4. Download videos to the `.data` directory if they don't already exist
5. Extract audio from videos to `.data/mp3/` and delete the original video files
6. Generate/update an RSS XML feed in `.data/`

### Docker Usage

#### Build and run with Docker Compose (recommended)

```bash
docker-compose up -d
```

This will start the scraper container with:

- Default schedule: Daily at 2 AM UTC
- Data directory: `./data` (mounted locally)
- Auto-restart on failure

#### Configure the schedule, data, and RSS output

Edit `docker-compose.yml` to customize:

```yaml
environment:
  # Cron format: minute hour day month weekday
  # Examples:
  #   "0 2 * * *"     - Every day at 2 AM
  #   "0 */6 * * *"   - Every 6 hours
  #   "30 1 * * 0"    - Every Sunday at 1:30 AM
  SCHEDULE: "0 2 * * *"
  DATA_DIR: /data
  # Audio subdirectory under DATA_DIR
  AUDIO_SUBDIR: mp3
  # RSS output filename (written to DATA_DIR)
  RSS_OUTPUT_FILENAME: podcast.xml
  # Base URL used to build absolute enclosure URLs in the feed
  # Example: https://example.com/podcast
  FEED_BASE_URL: ""
  # Optional feed metadata overrides
  FEED_TITLE: "Mental Health Mondays"
  FEED_AUTHOR: "WTAP"
  FEED_DESCRIPTION: "Audio feed generated from WTAP Mental Health Mondays videos."
  FEED_LANGUAGE: en-us
  FEED_COPYRIGHT: ""
  FEED_IMAGE_URL: ""
```

#### Build Docker image manually

```bash
docker build -t wtap-scraper .
docker run -d \
  -e SCHEDULE="0 2 * * *" \
  -e DATA_DIR=/data \
  -v $(pwd)/data:/data \
  --restart unless-stopped \
  wtap-scraper
```

#### View logs

```bash
# With Docker Compose
docker-compose logs -f wtap-scraper

# With standalone container
docker logs -f wtap-scraper
```

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
- Saves with dates in filename (e.g., Mental-Health-Mondays-YYYY-MM-DD.mp4)

### RSS Feed Generation

The scraper generates a podcast RSS feed compatible with common players:

- MP3 files are written to `${DATA_DIR}/${AUDIO_SUBDIR}` (default: `.data/mp3`)
- An RSS XML file is written to `${DATA_DIR}/${RSS_OUTPUT_FILENAME}` (default: `.data/podcast.xml`)
- Each item includes title, description, publication date, enclosure URL, and optional duration
- Enclosure URLs are built from `FEED_BASE_URL` + `/${AUDIO_SUBDIR}/<filename>`; set `FEED_BASE_URL` to the public URL where you host the files
- Feed metadata (title, author, description, language, image) can be customized via environment variables

## File Structure

```
.
├── src/
│   └── scraper.ts           # Main scraper script
├── .data/                    # Downloaded data (gitignored)
│   └── mp3/                  # Extracted audio files (default subdir)
│   └── podcast.xml           # Generated RSS feed (default filename)
├── data/                     # Docker mounted data directory
├── Dockerfile                # Container image definition
├── docker-compose.yml        # Docker Compose configuration
├── package.json
├── tsconfig.json
├── eslint.config.ts
└── AGENTS.md
```

## Dependencies

- **axios**: HTTP client for fetching pages
- **cheerio**: HTML parsing
- **puppeteer**: Headless browser for JavaScript rendering
- **tsx**: TypeScript execution

## External Dependencies

- **ffmpeg**: Required for audio extraction from videos
  - Local installation: Install via your package manager (brew, apt, etc.)
  - Docker: Automatically installed in the container

## Environment

- Node.js 20+ (local)
- Docker and Docker Compose (for containerized deployment)
- ffmpeg (for audio extraction)
