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

## Triggers

Triggers start a bot without anyone asking. Set them up on the **Triggers** screen (Owner, Manager or KenjiFlow Admin). There are quick starts for the B2B pack.

- **Schedules:** every hour, every day, weekdays or once a week, at a time in the business's timezone (`timezone` in the business profile, otherwise the server's). One run per slot. A run missed while the engine was down catches up once, when it restarts.
- **App events:** for example a new Gmail message or a new HubSpot deal. The event list comes from the connected app (Composio). Events arrive over Composio's realtime stream, so the engine needs no public URL.
- **When one fires:** the bot gets the event data, marked as data and not instructions, plus the trigger's instructions. It decides what to do, creating tasks as usual. Those tasks show source `schedule` or `trigger` and "created by bot".
- **Safety:**
  - Events are de-duplicated, and each trigger has a max-runs-per-hour limit (default 20).
  - The team gets a feed alert when a trigger hits its limit.
  - Turned-off triggers and the kill switch skip events.
  - Approvals and test mode apply as normal.
- **Testing and history:** "Run now" fires a trigger by hand, and "History" shows each event and what happened to it.

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
| `KF_ENGINE_URL` | Desktop app: connect to a remote engine instead of starting one |
| `KF_OWNER_EMAIL`, `KF_OWNER_PASSWORD`, `KF_OWNER_NAME`, `KF_BUSINESS_NAME` | First-run owner account for a real client install |
| `KF_WHISPER_BIN`, `KF_WHISPER_MODEL` | Dictation: whisper.cpp binary and model (or drop them in `<userData>/whisper/`) |

## Not built yet

- Composio webhooks as an alternative to the realtime stream, for servers with a public URL.
- Pushing each client's monthly usage to a central KenjiFlow billing dashboard (today: read it per client in Settings or in Composio's per-project usage).
- Scheduler for recurring tasks, Windows installer signing + auto-update, Docker image for the client server.
- Learn-from-edits memory beyond passing the edit back to the bot in chat.
