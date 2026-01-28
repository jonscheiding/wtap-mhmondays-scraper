FROM node:20-alpine

# Install ffmpeg and cron
RUN apk add --no-cache ffmpeg dcron

# Set working directory
WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm and dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Copy application code
COPY src ./src
COPY tsconfig.json eslint.config.ts ./

# Create data directory with default permissions
RUN mkdir -p /data

# Set default environment variables
ENV DATA_DIR=/data
ENV SCHEDULE="0 2 * * *"
ENV NODE_ENV=production

# Create a cron job runner script
RUN cat > /app/run-cron.sh << 'EOF'
#!/bin/sh
set -e

# Create crontab entry
CRON_JOB="$SCHEDULE cd /app && DATA_DIR=$DATA_DIR pnpm run scrape >> /var/log/scraper.log 2>&1"
echo "$CRON_JOB" | crontab -

# Start cron daemon in foreground
crond -f -l 2
EOF

RUN chmod +x /app/run-cron.sh

# Health check
HEALTHCHECK --interval=60s --timeout=10s --start-period=10s --retries=3 \
  CMD test -f /var/log/scraper.log || exit 1

# Run the cron daemon
CMD ["/app/run-cron.sh"]
