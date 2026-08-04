FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

RUN mkdir -p /app/recordings

EXPOSE 4000
CMD ["node", "src/index.js"]
