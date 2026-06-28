# slider-puzz

A Telegram Mini App for a sliding image puzzle game with backend, frontend, and admin support.

## Contents

- `bot/` — Telegram bot + Express API + PostgreSQL backend
- `web/` — Static frontend and admin panel served from `web/public`
- `render.yaml` — Render deployment manifest

## Local setup

1. Copy `.env.example` to `.env` and fill in values.
2. Install dependencies:
   ```bash
   npm run install:all
   ```
3. Start the bot backend:
   ```bash
   npm run start:bot
   ```
4. Start the web frontend separately (optional):
   ```bash
   npm run start:web
   ```

> The bot backend serves the frontend from `bot/index.js` using the static files in `web/public`.

## Environment variables

Required environment variables for Render or local run:

- `BOT_TOKEN` — Telegram bot token
- `JWT_SECRET` — secret for admin JWT tokens
- `ADMIN_USERNAMES` — comma-separated Telegram usernames allowed to access admin features
- `WEB_APP_URL` — public URL for the web app (e.g. `https://<your-render-service>.onrender.com`)
- `DATABASE_URL` — PostgreSQL connection URL

## Render deployment

The app is configured to run with a single Render web service.

### Recommended Render service

- `Build Command`: `npm run install:all`
- `Start Command`: `cd bot && npm start`
- Link a PostgreSQL database service and set `DATABASE_URL`
- Set environment variables above in Render

### Access URLs

- Main game: `https://<your-render-service>.onrender.com/`
- Admin panel: `https://<your-render-service>.onrender.com/admin.html`

## AWS Deployment (Docker / ECS / Elastic Beanstalk)

This repository includes Dockerfiles and a `docker-compose.yml` to run services locally and prepare images for AWS.

High-level options to host the backend (`bot`) on AWS:

- Elastic Container Service (ECS) with Fargate: build and push the `bot` image to ECR, create a task definition and service.
- Elastic Beanstalk (Docker): create a single-container environment using the `bot` Dockerfile or a multi-container environment with `docker-compose.yml`.

Quick ECR + ECS (Fargate) workflow:

1. Authenticate to ECR and create a repository for the bot image.

```bash
# build image
docker build -t slider-puzz-bot:latest -f bot/Dockerfile ./bot

# tag for ECR (replace <aws-account>, <region>, <repo>)
docker tag slider-puzz-bot:latest <aws-account>.dkr.ecr.<region>.amazonaws.com/<repo>:latest

# login, push
aws ecr get-login-password --region <region> | docker login --username AWS --password-stdin <aws-account>.dkr.ecr.<region>.amazonaws.com
docker push <aws-account>.dkr.ecr.<region>.amazonaws.com/<repo>:latest
```

2. Create an ECS Task Definition referencing the pushed image and an ECS Service running it (Fargate recommended). Set environment variables and secrets (BOT_TOKEN, DATABASE_URL, JWT_SECRET, WEB_APP_URL, ADMIN_USERNAMES).

3. Ensure the container has an attached EFS or S3-backed storage if you need persistent uploads (the app writes to `web/public/uploads`). Alternatively, change uploads handling to use S3 for scalability.

Elastic Beanstalk (single container) quick steps:

1. In the `bot` folder, use the included `Dockerfile` and create an EB application/environment.
2. You can deploy using the AWS EB CLI:

```bash
cd bot
eb init -p docker slider-puzz-bot --region <region>
eb create slider-puzz-bot-env
eb deploy
```

Notes and recommendations:

- When running in AWS, prefer storing uploaded images in S3 rather than local disk. Update `bot/index.js` to upload processed images to S3 and serve them via S3 public URLs or CloudFront.
- Use AWS Secrets Manager or Parameter Store for sensitive env vars, and reference them in ECS task definitions or EB environment configs.
- Open the container port (default `PORT=3000`) in your task/EGress/security groups.

If you want, I can:

- Add S3 upload integration to `bot/index.js` and update the admin UI to show S3 URLs.
- Create an example CloudFormation or Terraform snippet for ECS service deployment.
- Add a `Dockerrun.aws.json` or EB-specific config for an Elastic Beanstalk Docker deployment.


## Notes

- The Telegram bot and frontend integrate using Telegram Web App `initData`.
- Admin routes require Telegram username membership in `ADMIN_USERNAMES`.
