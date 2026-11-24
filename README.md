# KenjiFlow Staff

AI staff for small businesses: a Windows app plus an always-on engine. Each business gets a team of Claude-powered bots (Chief of Staff, Sales, Finance, Inbox…) that take on tasks, use the business's own apps, and ask a person before anything important leaves the business.

## What it does

- **Chat with each bot.** Questions get answers; requests to do something become tracked tasks.
- **Tasks board.** Queued, in progress, approval needed, awaiting your answer and ready for review. Only a person marks work done.
- **Approvals.** Emails and app changes wait for the right person, by role and by each bot's autonomy setting. Approve from the desktop or from your phone, with push notifications.
- **Connected apps.** Gmail, HubSpot, QuickBooks, Google Calendar, Slack and more through [Composio](https://composio.dev), using the business's own accounts.
- **Recurring work.** Ask a bot for "every Monday at 9…" or "whenever a new lead emails…" and it sets up the schedule or app trigger itself.
- **Big jobs.** Heavy work (crunching an export, building a report or spreadsheet) runs in an Anthropic Managed Agent sandbox with a hard spend limit.
- **Information feed, files and artifacts, team logins with roles, an activity log and a kill switch.**

## How it's built

| Part | Tech |
|---|---|
| Engine | Node.js REST + websocket API, Postgres (PGlite locally) |
| AI | Claude (`claude-opus-5-5`) through the Anthropic SDK |
| Desktop app | Electron, plain JavaScript UI |
| Phone page | Installable web page with Web Push |
| Server | Docker Compose with Postgres and Caddy (automatic HTTPS) |

## Quick start

```bash
cd app
npm install
npm run dev     # engine + UI in a browser at http://localhost:4310
npm start       # Windows app
npm test
```

Without a Claude API key the app runs in **demo mode** with a scripted stand-in for Claude, so every flow can be clicked through for free. Demo logins are in `app/engine/seed.js`.

Setup for connected apps, Gmail, recurring tasks, big jobs and the always-on company server is in [app/README.md](app/README.md).

## License

[Functional Source License 1.1, Apache 2.0 future license](LICENSE.md) (FSL-1.1-ALv2). You may use, change and share the code for anything except a competing commercial product or service. Each version becomes Apache 2.0 two years after its release.

"KenjiFlow" and its logos are trademarks of KenjiFlow and are not covered by the license.

## Security

See [SECURITY.md](SECURITY.md) to report a vulnerability.
