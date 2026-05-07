FROM node:20-alpine

WORKDIR /app

# Install system dependencies
RUN apk add --no-cache openssl libc6-compat wget

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for Prisma CLI)
RUN npm ci

# Copy Prisma schema first
COPY prisma ./prisma

# Copy application code
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Remove devDependencies to reduce image size
RUN npm prune --production && \
    npm cache clean --force

# Change ownership
RUN chown -R nodejs:nodejs /app

# Use non-root user
USER nodejs

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1

# Wait for PostgreSQL before running Prisma migrations
CMD ["sh", "-c", "echo 'Waiting for PostgreSQL...' && sleep 15 && npx prisma migrate deploy && node index.js"]