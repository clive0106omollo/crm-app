# CRM – Healing the Roots 2026 (installable web app)

Opens in any browser, installs on Android and iPhone, and does not need claude.ai.
Registrations, sessions, PDF resources and organiser login are stored by this app's own server.

## Deploy on Render (about 10 minutes)

1. Create a free GitHub account, then a new **private** repository, and upload everything in this folder
   (`server.js`, `package.json`, `render.yaml`, `public/` ...).
2. In Render: **New → Blueprint**, choose the repository. Render reads `render.yaml` and creates the web app and database.
3. When asked for **ADMIN_PASSWORD**, type a strong password. This is the organiser password.
4. Click **Apply**. After a few minutes you get a link like `https://crm-healing-the-roots.onrender.com`.
5. Open the link, go to **Settings**, and sign in with the organiser password.

Manual setup instead of Blueprint: create a PostgreSQL database, then a Web Service (Node)
with build command `npm install`, start command `npm start`, and environment variables
`DATABASE_URL` (the database's Internal Connection String), `ADMIN_PASSWORD`, `SESSION_SECRET` (any long random text).

## Cost note
Render's free web service sleeps when idle (first load takes about 30 seconds) and free databases are deleted after 30 days.
For a live event, use the paid Starter web service and a paid database (`render.yaml` already does this) so data is kept.

## How attendees install it
- Android (Chrome): open the link, then ⋮ menu → Install app / Add to Home screen.
- iPhone (Safari only): open the link, then Share → Add to Home Screen.

## How it works
- Attendees need no account. Each phone gets a private anonymous ID, so they can register once and update their own details.
  If they clear browser data or use another device, they appear as a new person and an organiser can remove duplicates.
- Organisers sign in with the shared password (Settings). The sign-in lasts 3 days.
- Only organisers can see the full registration list, attendance and reports.
- PDF resources are stored in the database and shown inside the app with no download button.
  This discourages copying, but nothing on the web can fully prevent screenshots.
