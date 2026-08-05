# Datalix

Data bundle reseller website (MTN, AirtelTigo, Telecel) for Ghana, statically
exported from WordPress + WooCommerce and rebranded to Datalix. A small
Express server serves the static files, handles clean URLs like
`/mtn-data-bundles/`, and now runs real checkout through your **Payment Hub**.

## What was broken, and what changed

**The bug you saw (duplicated homepage, "Buy Now" going nowhere useful):**
Every page's CSS/JS/image links used *relative* paths (`wp-content/...`
instead of `/wp-content/...`). The old server also had a catch-all that
silently served the homepage's raw HTML at whatever broken URL you landed on
when "Buy Now" failed. Combined, that meant the homepage's stylesheet
couldn't load at that URL — so the responsive mobile/desktop hero blocks
(which are supposed to be one-or-the-other via CSS) both showed at once,
looking like duplicated content.

Fixed:
- Every asset reference across all pages now uses root-absolute paths
  (`/wp-content/...`, `/assets/...`), so it renders correctly no matter what
  URL it's served at.
- The server now returns a real `404.html` for unmatched routes instead of
  silently rendering the homepage at the wrong URL.
- Removed 16 leftover HTTrack crawler artifact files at the root
  (`index24eb.html` etc.) and the dead `<link rel="shortlink">` tags that
  pointed at them.

**Buy Now now actually works.** MTN Data Bundle, Telecel Data Bundles, and
AirtelTigo Data Bundles are the three in-stock products. Tapping Buy Now:
1. Opens a checkout panel (choose bundle size → name, phone number to
   receive the data, optional email).
2. Calls this site's own `/api/checkout`, which calls your **Payment Hub**,
   which calls Paystack, and returns a Paystack checkout link.
3. Customer pays by card or Mobile Money on Paystack's page.
4. Paystack → Hub → back to `/order/:id/thank-you` on this site, which
   re-verifies the payment and shows a real confirmation.
5. You see the order (and its payment status) at `/admin/orders`.

(MTN Afa and Apple Music Subscription have no buy button because they're
genuinely marked "Out of stock" in the original data — that's not a bug.)

**Important — fulfillment is still manual.** This site takes payment and
records the order. It does **not** automatically top up anyone's phone —
there's no telco API wired in. After a payment shows `SUCCESS` in
`/admin/orders`, you still need to actually send the data bundle to the
customer's number yourself.

## Required environment variables (set these in Railway → Variables)

| Variable | What it is |
|---|---|
| `SITE_URL` | This site's public URL, e.g. `https://datalix.up.railway.app` |
| `HUB_URL` | Your Payment Hub's public URL |
| `HUB_API_KEY` | The apiKey the hub gave you for the Datalix merchant |
| `HUB_API_SECRET` | The apiSecret the hub gave you for the Datalix merchant |
| `ADMIN_KEY` | Any long random string you make up — gates `/admin/orders` |

See `.env.example`. Never commit real values for these — `.env` is
gitignored.

⚠️ On your Payment Hub, make sure the Datalix merchant's registered
`webhookUrl` is `https://<this-site>/webhooks/hub` — that's how payments get
marked SUCCESS automatically even if the customer closes the browser tab
before landing on the thank-you page.

⚠️ **Railway's filesystem is ephemeral** — `data/orders.json` will reset on
redeploys unless you attach a persistent volume (Railway → your service →
Settings → Volumes, mounted at `/app/data`) or move order storage to a real
database later. Fine for getting started; worth fixing before high volume.

## Local development

```bash
cp .env.example .env   # fill in real values
npm install
npm start
```

Visit http://localhost:3000

## Deploy: GitHub → Railway

1. Push this repo to GitHub.
2. Railway → New Project → Deploy from GitHub repo → select this repo.
3. Add the environment variables above in Railway → Variables.
4. Railway auto-detects Node and runs `npm start` (see `railway.json`).

## Still not wired up (from the original export)

- `/login/`, `/login-2/`, `/register/`, `/forgot/`, `/membership-*` — these
  are Paid Memberships Pro pages with no real backend. They render but don't
  authenticate anyone. Out of scope for this pass — say the word if you want
  real accounts/login built.
- Product copy/pricing was carried over as-is from the original site —
  worth a review pass.
- No `robots.txt` / `sitemap.xml` yet for the real domain.

## Images

All site photos/logos live in `assets/images/`, referenced as
`/assets/images/<filename>` everywhere, so they resolve correctly no matter
how deep a page is.
