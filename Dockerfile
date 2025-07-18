# Stage 1: Build the application
FROM node:20-alpine AS builder
WORKDIR /src/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Production image
FROM node:20-alpine AS runner
WORKDIR /src/app
COPY --from=builder /src/app/dist ./dist
COPY package*.json ./
RUN npm ci --only=production

EXPOSE 8080
CMD [ "node", "dist/server.js" ]