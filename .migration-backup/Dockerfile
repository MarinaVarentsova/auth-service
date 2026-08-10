FROM node:20-alpine

WORKDIR /app

# Disable Next.js anonymous telemetry for both build and runtime.
ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json ./

RUN npm install

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start"]
