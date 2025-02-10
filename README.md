# Cloudflare Workers Hono Api Template with D1, Drizzle, and Resend

## Setup

- create `.dev.vars` file with your Resend API key:
```
RESEND_API_KEY=<your-api-key>
```

- Create a new D1 database and get the id
- Create a new KV namespace and get the id
- put the proper id's in the `wrangler.jsonc` file

- create a `.env` file with your Cloudflare D1 infos (for migrations):
```
CLOUDFLARE_ACCOUNT_ID=<your-account-id>
CLOUDFLARE_DATABASE_ID=<your-database-id>
CLOUDFLARE_D1_TOKEN=<your-d1-token>
```

```
npm install
npm run dev
```
npm run deploy
```


