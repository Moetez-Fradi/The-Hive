FROM node:20-slim
WORKDIR /
COPY package*.json ./
RUN npm install --only=production
COPY . .
EXPOSE 80
CMD ["node", "index.js"]