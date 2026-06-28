FROM node:18-alpine
WORKDIR /usr/src/app

# install dependencies
COPY package*.json ./
RUN npm ci --only=production

# copy source
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
