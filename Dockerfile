FROM node:20-alpine

# Install ffmpeg
RUN apk add --no-cache ffmpeg chromium

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true pnpm install --frozen-lockfile

# Copy application code
COPY src ./src
COPY tsconfig.json eslint.config.ts ./

# Create data directory with default permissions
RUN mkdir -p /data

# Set default environment variables
ENV DATA_DIR=/data
ENV SCHEDULE="0 2 * * *"
ENV NODE_ENV=production
ENV NODE_OPTIONS="--unhandled-rejections=strict"
ENV CHROMIUM_PATH=/usr/bin/chromium-browser

# Create a scheduler script
RUN cat > /app/run-scheduler.sh << 'EOF'
#!/bin/sh
set -e

# Run scraper immediately on startup
echo "Starting initial scrape run..."
cd /app && DATA_DIR=$DATA_DIR pnpm run scrape

# Parse cron schedule to calculate next run time in seconds
# For now, we'll use a simple approach: run at the specified interval
# Default schedule "0 2 * * *" means daily at 2 AM UTC
# We'll calculate interval from current time to next 2 AM, then repeat every 24 hours

echo "Scheduler started, will run daily at 02:00 UTC"

# Simple daily scheduler at 2 AM UTC
while true; do
CURRENT_HOUR=$(date +%H)
CURRENT_MIN=$(date +%M)

# If before 2 AM, sleep until 2 AM
# If after 2 AM, sleep until 2 AM tomorrow
if [ "$CURRENT_HOUR" -lt 2 ] || ([ "$CURRENT_HOUR" -eq 1 ] && [ "$CURRENT_MIN" -lt 0 ]); then
SLEEP_HOURS=$((2 - CURRENT_HOUR))
SLEEP_MINS=$((60 - CURRENT_MIN))
SLEEP_SECS=$(((SLEEP_HOURS * 3600) + (SLEEP_MINS * 60)))
else
# Hours until 2 AM tomorrow
SLEEP_HOURS=$((26 - CURRENT_HOUR))
SLEEP_MINS=$((60 - CURRENT_MIN))
SLEEP_SECS=$(((SLEEP_HOURS * 3600) + (SLEEP_MINS * 60)))
fi

echo "Next scrape in $SLEEP_SECS seconds (at 02:00 UTC)"
sleep "$SLEEP_SECS"

echo "Running scheduled scrape..."
cd /app && DATA_DIR=$DATA_DIR pnpm run scrape
done
EOF

RUN chmod +x /app/run-scheduler.sh

# Health check
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD test -d /data || exit 1

# Run the scheduler
CMD ["/app/run-scheduler.sh"]
