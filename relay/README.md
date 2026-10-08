# Productor relay

A Cloudflare Worker that receives GitHub webhooks and fires automation
schedules, holding them until the Productor Mac app connects to collect them.

## Deploy

```sh
cd relay
pnpm install
pnpm exec wrangler login
pnpm exec wrangler deploy
openssl rand -hex 32 | pnpm exec wrangler secret put RELAY_TOKEN
openssl rand -hex 32 | pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET
```

Keep both generated values: the token goes into Productor (Automations →
Relay), the webhook secret into GitHub.

## Connect GitHub

In the repository or organisation settings, add a webhook:

- Payload URL: `https://<your-worker>/hooks/github`
- Content type: `application/json`
- Secret: the `GITHUB_WEBHOOK_SECRET` value
- Events: Pull requests, Pull request reviews, Pull request review comments,
  Issue comments, Check suites

## Develop

```sh
printf 'RELAY_TOKEN=test-token\nGITHUB_WEBHOOK_SECRET=test-secret\n' > .dev.vars
pnpm dev --port 8799
```

The app's ignored test `collects_a_webhook_from_the_relay_and_runs_the_automation`
runs against that local server.
