# KenjiFlow Staff (MVP)

AI bots for small businesses: a Windows app plus an always-on engine. See `../SCOPE.md` for the full plan.

## Run it

```
npm install
npm run dev        # engine + UI in a browser at http://localhost:4310
npm start          # Windows app (starts its own local engine if KF_ENGINE_URL isn't set)
npm test           # engine end-to-end tests + avatar tests
```

Demo logins are in `engine/seed.js`. With no `ANTHROPIC_API_KEY` set, the engine runs in **demo mode**: a scripted stand-in for Claude, so every flow (tasks, approvals, questions, artifacts) can be clicked through for free. Set the key and restart to use Claude (`claude-opus-5-5`, effort `medium`; change with `KF_MODEL` / `KF_EFFORT`).

## What's in the box

| Area | Where |
|---|---|
| Engine: REST API + websocket | `engine/server.js` |
| Data (Postgres via `DATABASE_URL`, else PGlite on disk) | `engine/db.js`, `engine/store.js` |
| Bot loop (Claude tool use, one turn at a time per bot) | `engine/runtime.js`, `engine/llm.js` |
| Bot tools + risk tags, approval policy | `engine/tools.js`, `engine/policy.js` |
| Big jobs (Managed Agents sandboxes) | `engine/bigjobs.js` |
| Outside actions (Gmail etc.; logged only in test mode) | `engine/connectors.js` |
| Industry pack (bots, rules, task templates) | `engine/packs/b2b-services.json` |
| Windows app shell, local dictation | `desktop/` |
| UI | `renderer/` (`views/` per screen) |
| Bot faces (12 shapes, any colours, no background) | `renderer/avatars.js`, preview at `/avatar-gallery.html` |

## Connect Claude

Use the business's own Anthropic account so they own the bill.

1. In console.anthropic.com, open **API keys** and create a key.
2. In the app, open **Settings > Claude**, paste the key and click **Save key**.

The engine checks the key with Anthropic (no tokens spent), stores it encrypted, and the bots switch from demo mode right away. You don't need to restart.

Alternatively, put `ANTHROPIC_API_KEY=` in `app/.env` (copy `.env.example`) and restart the engine. A key saved in Settings wins over `.env`.

## Connected apps (default: Composio on KenjiFlow's account)

Clients never sign up for anything. Composio runs on KenjiFlow's account:

1. **Setup, once per client (KenjiFlow Admin):**
   - In KenjiFlow's Composio dashboard, create a project for the client and copy its API key.
   - In the app, sign in with a **KenjiFlow Admin** login, then go to **Settings > Connected apps**, paste the key and set the client's plan: included actions per month, the overage price, and an optional hard stop.
   - Or set `COMPOSIO_API_KEY` on the client's server.
2. **The client:** clicks **Connect** next to Gmail, HubSpot, QuickBooks, Calendar and so on, then signs in to that app. There's no Google Cloud or Intuit developer setup.

How it behaves:
- **Isolation:** one project per client means the key on a client's server can only reach that client's connections. Never put the org-wide key on a client server.
- **Bot tools:** bots get `app_find_actions` (look up what an app can do) and `app_run_action` (do it).
- **Risk and approvals:** the risk level comes from the action name. Reads run straight away. Sends follow the bot's autonomy level. Changes need approval only under "Ask for everything". Payments and deletes always ask. Test mode blocks everything except reads.
- **Billing:** every app action is counted. Settings shows the client a monthly meter. The team gets a feed alert at 80% and 100%, and KenjiFlow Admins see a per-month table to invoice overage from.
- **Our cost:** Composio's Hobby plan is free up to 20,000 managed-app calls a month, across all clients combined. Pro is $29/month plus about $0.30 per 1,000 calls (check current pricing).

## Recurring tasks

Bots set up repeating work themselves. Ask in chat ("every Monday at 9, send me a pipeline summary", "whenever a new lead emails, draft a reply") and the bot creates a recurring task with `set_up_recurring`. When a one-off request is clearly routine, the bot offers to make it recurring. To change or stop one, ask the bot (`change_recurring`, `remove_recurring`).

People see them under **Tasks > Recurring**: pause, run once, history and delete.

- **Schedules:** every hour, every day, weekdays or once a week, at a time in the business's timezone (`timezone` in the business profile, otherwise the server's `TZ`). One run per slot. A run missed while the engine was down catches up once, when it restarts.
- **App events:** for example a new Gmail message or a new HubSpot deal. The bot looks up an app's events with `find_app_events`. Events arrive over Composio's realtime stream, so the engine needs no public URL.
- **Each run:** the bot gets the event data, marked as data and not instructions, plus the recurring task's instructions. It creates a task as usual, with source `schedule` or `trigger` and "created by bot".
- **Safety:**
  - Events are de-duplicated, and each recurring task runs at most 20 times an hour. The team gets a feed alert when one hits that.
  - Paused ones and the kill switch skip runs.
  - Approvals and test mode apply as normal.

## Big jobs

Work too heavy for a chat turn (crunching an export, building a report, spreadsheet, Word or PowerPoint file) runs in an Anthropic Managed Agent. The bot calls `start_big_job`, the job runs in its own cloud sandbox, and the bot gets a `[Big job finished]` message with the summary. Output files land on the task.

- **Cost:** on the client's own Claude bill, at normal token rates plus $0.08 per running hour and $10 per 1,000 web searches. Each job stops at a hard limit, $5 by default (**Settings > Safety**, $0.50 to $50). The cost shows on the task.
- **Approvals:** the sandbox holds no logins, so it can only make files. Sending anything still goes through the bot's own tools. Bots on "Ask for everything" need approval to start a job.
- **Web:** off by default. An Owner can allow it in **Settings > Safety**. Web jobs get open internet in their sandbox, because research sites can't be listed up front.
- **Limits:** three jobs at once, an hour each. The kill switch, cancelling the task, and the Stop button on the task all stop a job and keep what it finished. Anything the sandbox pauses to ask about is refused, since nobody is watching.
- **Restarts:** jobs are polled, so a restarted engine picks them up again. The agent and environment are created once per client on the first job, and again if the Claude key changes.

## Company server (always on)

For a real client the engine runs on a small cloud server the client owns, so bots, recurring tasks and approvals keep working with every PC off. Any VPS with 2 GB RAM works (e.g. Hetzner or DigitalOcean, about $10-25/month). The files are in `deploy/`.

1. Create the server (Ubuntu), install Docker, and point a domain such as `staff.clientname.com` at its IP.
2. Copy this `app` folder to the server. In `deploy/`, copy `.env.example` to `.env` and fill it in: the domain, the Owner login, a database password, `KF_SECRET_KEY` (keep a copy somewhere safe) and `TZ`.
3. In `deploy/`, run `docker compose up -d --build`. Caddy gets the HTTPS certificate on its own. Check that `https://<domain>/api/health` answers.
4. On each PC, in the Windows app's sign-in screen, click **Change** next to "Server" and enter `https://<domain>`. The app restarts against the server. The full app also works in a browser at the same address.
5. Each person opens `https://<domain>/m` on their phone, signs in and taps **Get notified**. On iPhone, add it to the Home Screen first. Approval requests and bot questions then arrive as notifications and can be handled from the phone.

Server safety:
- With `NODE_ENV=production` (set in the image), the engine refuses to start without `KF_OWNER_EMAIL` and a 12+ character `KF_OWNER_PASSWORD`.
- Ten wrong passwords from one address block sign-in from it for 15 minutes.
- Owners and KenjiFlow Admins can read every sign-in, approval, setting change and outside action in **Settings > Activity log**.
- `GET /api/health` is public, for uptime monitoring.

## Direct Gmail (advanced, once per client, about 15 minutes)

Only for clients who don't want a third party in the loop.

The client needs Google Workspace. Personal @gmail.com accounts get Google's "unverified app" warning.

1. Signed in as a Workspace admin, go to console.cloud.google.com and create a project, e.g. "KenjiFlow Staff".
2. **APIs & Services > Library**: enable the **Gmail API**.
3. **APIs & Services > OAuth consent screen** (Google Auth Platform):
   - Set **User type** to **Internal**, which needs no Google verification.
   - Enter an app name and a support email.
   - Under Data access, add the scopes `gmail.readonly`, `gmail.send` and `userinfo.email`.
4. **Credentials > Create credentials > OAuth client ID**:
   - Choose type **Web application**.
   - Under **Authorised redirect URIs**, paste the URI shown in the app's **Settings > Gmail**. That's `http://localhost:4310/api/connectors/gmail/callback` locally, or `https://<their domain>/api/connectors/gmail/callback` on their server with `KF_PUBLIC_URL` set.
5. Copy the **Client ID** and **Client secret** into **Settings > Gmail**, then click **Save Google app**.
6. Click **Connect Gmail** and sign in as the mailbox the bots should use, e.g. the owner or sales@. Approve the access.

Once connected:
- Bots get `search_email` and `read_email`.
- Approved `send_email` actions send from that mailbox.
- **Test mode** (Settings > Safety) still blocks every send. Turn it off when the client is ready.

## Settings (env vars)

| Var | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Client's own Claude key (or save it in Settings). Neither = demo mode |
| `KF_PUBLIC_URL` | The engine's public address, used for the Gmail sign-in redirect |
| `COMPOSIO_API_KEY` | This client's Composio project key (or set it in Settings as KenjiFlow Admin) |
| `KF_SECRET_KEY` | Master key for stored secrets (default: generated `data/secret.key`) |
| `DATABASE_URL` | Postgres on the client's server. Unset = local PGlite in `data/` |
| `KF_DATA_DIR` | Where PGlite data and files live |
| `PORT`, `HOST` | Engine address (default `127.0.0.1:4310`) |
| `KF_ENGINE_URL` | Desktop app: connect to a remote engine instead of starting one (overrides the server set on the sign-in screen) |
| `KF_TRUST_PROXY` | `1` behind the HTTPS proxy, so sign-in limits use the caller's address (set in the image) |
| `KF_PUSH_CONTACT` | Contact sent to push services, `mailto:` or `https:` (default: `KF_PUBLIC_URL`) |
| `KF_OWNER_EMAIL`, `KF_OWNER_PASSWORD`, `KF_OWNER_NAME`, `KF_BUSINESS_NAME` | First-run owner account for a real client install |
| `KF_WHISPER_BIN`, `KF_WHISPER_MODEL` | Dictation: whisper.cpp binary and model (or drop them in `<userData>/whisper/`) |

## Not built yet

- Composio webhooks as an alternative to the realtime stream, for servers with a public URL.
- Pushing each client's monthly usage to a central KenjiFlow billing dashboard (today: read it per client in Settings or in Composio's per-project usage).
- Windows installer signing + auto-update.
- Unanswered approvals expiring into the next morning brief; "Always allow" on approval cards.
- Learn-from-edits memory beyond passing the edit back to the bot in chat.
