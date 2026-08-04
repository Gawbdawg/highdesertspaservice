# High Desert Spa Service

Operations dashboard for High Desert Spa Service: scheduling, customer records, invoicing, technician and vacation-owner portals, and weekly schedule emails.

## What it does

- **Today** — see all of today's appointments at a glance.
- **Calendar** — month-view calendar. Click any day to view, add, edit, or delete appointments for that date.
- **Customers** — each row is a *property*. Store contact info, address, and notes; tag each as Vacation rental or Residential; view appointment/invoice history; link it to an Owner account for portal access.
- **Owners** — portal login accounts. One owner account can be linked to several properties (e.g. someone who manages three vacation rentals logs in once and sees all three).
- **Technicians** — manage the technician list and give each one a portal login.
- **Invoices** — create invoices tied to a customer, track status (draft / sent / paid), see revenue/outstanding/overdue totals at a glance, and share a payment link customers can pay online with a card (once Stripe is set up — see below).
- **Daily Schedule** — pick a date and generate ready-to-copy text messages: one per technician (their full day's stops) and one per customer (appointment confirmation).
- **Property Calendar** — read-only view of every guest booking date range, whether entered manually or auto-synced from Airbnb/VRBO. Also has a "Sync all calendars now" button.
- **Requests** — service dates owners have requested through their portal; "Schedule" turns one into a real appointment in one click.
- **Settings** — the shop address routes are calculated from, and a "Geocode all addresses" button to map every property's location.

## Route-ordered schedules

Daily Schedule text, the technician portal's job list, and each technician's section of the weekly email are all ordered into an efficient driving route from the shop — not just sorted by appointment time. This needs two one-time setup steps in the **Settings** tab:

1. Confirm/save the shop address and click "Save & locate."
2. Click "Geocode all addresses" to map every property's location (takes a couple minutes for 100+ properties — it paces itself to respect the free geocoding service's rate limit). New properties you add later get located automatically when you save their address.

Route order is a nearest-neighbor heuristic over straight-line distance, not real driving time — no API key needed, and it works well for a small town, but it isn't true turn-by-turn optimization. A paid service (Google Directions/Mapbox) would be the upgrade path if routes ever look off in practice.

### Technician portal — `/tech`

Each technician gets their own username/password (set in the Technicians tab). They log in at **yourapp.com/tech** and see only their own upcoming jobs, with a button to mark each one complete. From the admin Technicians tab, click **View portal** next to any technician to open their view directly without needing their password.

### Owner (customer) portal — `/owner`

Owner accounts (Owners tab) are separate from properties (Customers tab) so one person can manage multiple properties under a single login — link as many properties to one owner as needed from the Customers tab. Any customer (residential or vacation) can be linked to an owner account for portal access.

Once logged in at **yourapp.com/owner**, an owner can:
- Request a specific service date for any of their properties (extra clean, repair, etc.) — shows up in the admin **Requests** tab.
- For vacation rental properties only: mark guest check-in/check-out date ranges manually, **or** paste their Airbnb/VRBO iCal export link to auto-sync booking dates (Listing → Availability → Sync calendars → Export calendar in Airbnb). Auto-synced dates are tagged "Auto-synced" and get refreshed each sync; manually-added dates are left alone.

From the admin Customers or Owners tab, click **View portal** to open an owner's view directly without needing their password.

### Admin (office) login

The main dashboard itself requires a login. The very first time you open it, you'll be prompted to create the office admin account (name, username, password) right there in the browser — no server access needed. After that, anyone opening the app sees a login screen instead. Add more admin logins (e.g. one for you, one for your brother) from the **Settings** tab under "Admin accounts."

There's no "forgot password" flow yet — if everyone's locked out, the fix is to clear `data/data.json` on the server (or, on a fresh install, just reach the setup screen again), which unfortunately also clears all other data. Keep the login details somewhere safe.

## Running it locally

Requires [Node.js](https://nodejs.org) 18+.

```bash
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

Data is stored in `data/data.json` (created automatically on first run, seeded from `data/seed-customers.json` if present). It's excluded from git, so each environment keeps its own data — back that file up if you care about the data in it.

## Deploying so it's usable from anywhere

This app needs a host with **persistent disk storage** (because it saves data to a local JSON file) — plain static hosts like GitHub Pages won't work. Good simple options that deploy straight from this GitHub repo:

- **[Railway](https://railway.app)** — connect the repo, it detects Node automatically, add a persistent volume mounted at `/app/data`.
- **[Render](https://render.com)** — "Web Service" from this repo, add a persistent disk mounted at `/opt/render/project/src/data`.

Both have free/low-cost tiers and auto-redeploy whenever you push to GitHub. **Render's free tier doesn't support persistent disks** — data resets on restart on Free (only the seeded customer list survives, from `data/seed-customers.json`). Upgrade to Starter ($7/mo) + a disk for real persistence.

### Environment variables to set on your host

| Variable | Required? | What it's for |
|---|---|---|
| `SESSION_SECRET` | Recommended | Signs technician/owner/admin login cookies. Set it to any long random string. Without it, a built-in fallback is used, which is fine for local testing only. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | For scheduled jobs | Login for an admin account (create one from the Settings tab), used by the weekly email, calendar sync, and reminder Cron Jobs to reach the now-protected admin API. |
| `GMAIL_USER` | For weekly emails | The Gmail address the weekly schedule is sent *from*, e.g. `highdesertspaservice@gmail.com`. |
| `GMAIL_APP_PASSWORD` | For weekly emails | A Gmail **App Password** (not the regular Gmail password) — see below. |
| `OWNER_EMAIL` | Optional | Where the full weekly schedule is sent (defaults to `highdesertspaservice@gmail.com`). |
| `APP_BASE_URL` | For scheduled jobs | Your deployed app's URL, e.g. `https://highdesertspaservice.onrender.com`. |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | For text reminders | From your [Twilio console](https://console.twilio.com). |
| `TWILIO_FROM_NUMBER` | For text reminders | The Twilio phone number to text from, e.g. `+15035551234`. |
| `STRIPE_SECRET_KEY` | For online invoice payments | From your [Stripe dashboard](https://dashboard.stripe.com/apikeys) — starts with `sk_live_` (or `sk_test_` for testing). |
| `STRIPE_WEBHOOK_SECRET` | For online invoice payments | From the webhook endpoint you set up in Stripe (see below) — starts with `whsec_`. |

## Weekly schedule emails

`npm run send-schedule` sends the coming week's (Monday–Sunday) schedule by email: a full summary to the office, and a filtered "just your jobs" email to every technician who has an email address on file. Without `GMAIL_USER`/`GMAIL_APP_PASSWORD` set, it prints what it *would* send instead of actually sending — safe to test with.

### One-time setup

1. **Get a Gmail App Password** for `highdesertspaservice@gmail.com`:
   - Turn on 2-Step Verification at [myaccount.google.com/security](https://myaccount.google.com/security) if it isn't already on.
   - Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), create one named "High Desert Ops," and copy the 16-character password it gives you.
2. On your host (Render/Railway), set the environment variables from the table above: `GMAIL_USER=highdesertspaservice@gmail.com`, `GMAIL_APP_PASSWORD=<the app password>`, `ADMIN_USERNAME`/`ADMIN_PASSWORD=<an admin login>`, `APP_BASE_URL=<your deployed URL>`.
3. **Schedule it to run weekly.** On Render: create a new **Cron Job** (separate from your Web Service, same repo), command `npm run send-schedule`, schedule e.g. `0 14 * * 1` (Monday 7am Pacific). On Railway: use a Cron trigger the same way.
4. Make sure each technician has an email address filled in on the Technicians tab — that's what the weekly email uses.

## Keeping vacation rental calendars in sync

Owners can hit "Save & sync now" in their own portal any time, and admins can click "Sync all calendars now" on the Property Calendar tab. To keep calendars fresh automatically without anyone remembering to click anything, schedule `npm run sync-calendars` the same way as the weekly email:

- Set `APP_BASE_URL` and `ADMIN_USERNAME`/`ADMIN_PASSWORD` in its environment.
- On Render: a **Cron Job**, command `npm run sync-calendars`, schedule e.g. `0 */6 * * *` (every 6 hours).

## Text (SMS) reminders

`npm run send-reminders` texts every customer with a scheduled appointment *tomorrow* and a phone number on file, once per appointment (re-running the same day won't double-text anyone). There's also a "Text reminder" button on each appointment in the Calendar day view, for a one-off manual send. Without the `TWILIO_*` env vars set, it prints what it *would* text instead of actually sending.

### One-time setup

1. **Create a [Twilio](https://www.twilio.com) account** and buy a phone number capable of sending SMS (a few dollars/month).
2. From the Twilio console, grab your **Account SID**, **Auth Token**, and the phone number you bought.
3. On your host, set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (e.g. `+15035551234`), plus `ADMIN_USERNAME`/`ADMIN_PASSWORD`/`APP_BASE_URL` from the table above.
4. **Schedule it to run daily.** On Render: a **Cron Job**, command `npm run send-reminders`, schedule e.g. `0 22 * * *` (2pm Pacific, the afternoon before each visit).
5. Customer phone numbers need to be valid 10-digit US numbers to receive a text (the Customers tab is where those live).

## Review requests

After marking an appointment complete, a "Send review request" button appears on it in the Calendar day view — texts the customer a link to leave a Google review. Set your link once in Settings (search your business on Google, click "Ask for reviews," copy the link).

To do this automatically instead of remembering to click it: `npm run send-review-requests` texts everyone whose appointment was completed *yesterday* and hasn't been asked yet. Schedule it the same way as the reminder script — a daily **Cron Job** with `APP_BASE_URL`, `ADMIN_USERNAME`/`ADMIN_PASSWORD`, and the `TWILIO_*` vars set, e.g. schedule `0 22 * * *`.

## Online invoice payments

Every invoice that isn't marked "paid" has a "Copy pay link" button in the Invoices tab, which copies a link like `yourapp.com/pay/12`. Send that to a customer (text, email, whatever) and they can pay by card through a Stripe-hosted checkout page — no login needed on their end. Once they pay, the invoice flips to "paid" automatically (tagged "Paid online").

### One-time setup

1. **Create a [Stripe](https://stripe.com) account.** You can test everything with test-mode keys before ever going live.
2. From the Stripe dashboard, grab your **Secret key** ([dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys)) and set it as `STRIPE_SECRET_KEY` on your host.
3. **Set up a webhook** so the app finds out when someone actually pays: in Stripe, go to Developers → Webhooks → Add endpoint, URL = `https://<your-app>/api/stripe/webhook`, and subscribe to the `checkout.session.completed` event. Copy the **Signing secret** it gives you and set it as `STRIPE_WEBHOOK_SECRET`.
4. That's it — no code changes needed. Until both env vars are set, the pay page tells customers online payment isn't turned on yet instead of erroring.

## Next steps (not built yet)

- QuickBooks sync for invoices.
