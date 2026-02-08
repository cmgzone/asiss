# Use Node.js LTS
FROM node:22-slim

# Install system dependencies required for Puppeteer (WhatsApp) and build tools
# Note: Puppeteer needs specific libraries to run in Docker
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libatk-bridge2.0-0 \
    libx11-xcb1 \
    libxcb-dri3-0 \
    libdrm2 \
    libgbm1 \
    libasound2 \
    libxss1 \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set environment variables for Puppeteer
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY . .

# Expose ports (Web UI)
EXPOSE 3000

# Start command
# We use ts-node for simplicity as per current dev setup
# In production, you might want to run 'npm run build' and then 'node dist/index.js'
CMD ["npm", "start"]
