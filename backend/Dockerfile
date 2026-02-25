FROM node:20-alpine

# Set timezone explicitly to Africa/Lagos
RUN apk add --no-cache tzdata
ENV TZ=Africa/Lagos

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy source code
COPY . .

# Build TypeScript to Javascript
RUN npm run build

EXPOSE 8000

# Create the data and sessions directory inside the container for mounting
RUN mkdir -p /app/sessions /app/data

# Start Backend Server
CMD ["npm", "start"]
