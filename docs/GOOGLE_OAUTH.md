# Setting up Google Calendar

Each household member connects their **own** Google accounts. They can connect several, such as personal, work and university. OUR HOME stores their tokens encrypted, and only that person can use them.

## 1. Create a Google Cloud project

1. Go to https://console.cloud.google.com/ and create a project (e.g. "OUR HOME").
2. **APIs & Services → Library**: enable **Google Calendar API**.

## 2. Configure the OAuth consent screen

**APIs & Services → OAuth consent screen** (called "Google Auth Platform" in newer consoles):

- User type: **External**
- App name: OUR HOME, plus your support email
- **Scopes:** add the following.
  - `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
  - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`: lists your calendars
  - `https://www.googleapis.com/auth/calendar.events.readonly`: imports events
  - `https://www.googleapis.com/auth/calendar.events`: only used when someone chooses **Allow adding events**, to add new events they export
- **Test users:** add both of your Google accounts (and any work or university accounts you'll connect).

While the app is in **Testing** mode, Google only lets listed test users sign in, and refresh tokens expire after **7 days**. The app then marks that account "Reconnect"; nothing breaks, but you will have to reconnect weekly. For a private two-person app, **publishing** the app removes the 7-day limit, but the Calendar scopes are classed as "sensitive", so Google shows an "unverified app" warning that each of you clicks through once. Verification is optional for personal use.

Some work or university Google accounts are run by an administrator who can block third-party apps. If connecting fails with an admin message, ask that organisation's admin.

## 3. Create OAuth credentials

**APIs & Services → Credentials → Create credentials → OAuth client ID**

- Application type: **Web application**
- Authorized JavaScript origins: `https://YOUR-SITE.netlify.app` (and `http://localhost:5173` for local development)
- Authorized redirect URIs:
  - `https://YOUR-SITE.netlify.app/api/google/callback`
  - `http://localhost:5173/api/google/callback` (local)

Copy the **Client ID** and **Client secret**.

## 4. Set environment variables

On Netlify (Site configuration → Environment variables, mark the secret as secret), and in `.env` locally:

```
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
APP_URL=https://YOUR-SITE.netlify.app        # http://localhost:5173 locally
TOKEN_ENCRYPTION_KEY=...                     # 32 random bytes, base64 (see README)
# optional, only if the redirect URI differs from ${APP_URL}/api/google/callback
GOOGLE_REDIRECT_URI=
```

Redeploy (or restart `npm run dev`). **Calendar → Google calendars** should now show **Connect a Google account** instead of "Not configured".

## 5. Use it

1. **Connect:** Calendar → Google calendars → *Connect a Google account*. Repeat for each account.
2. **Choose calendars:** tick the calendars you want to use.
3. **Import:** Calendar → *Import from Google*. Pick calendars and a destination (US or your private calendar). Review the events from today through six months ahead and choose which to import. Events marked private in Google are pre-set to **Busy only**, so their title, description and attendees are not shared.
4. **Check for changes:** Calendar → *Check for changes*. You'll see new events, events that changed in Google (field by field), and events that were removed. For each one, choose **Keep OUR HOME version** or **Update from Google**. Events you edited in OUR HOME default to *keep*, and events you deleted from a space are never re-imported.
5. **Export:** open any event → *Add to my Google Calendar*. Edit the details, choose one of *your* calendars, preview, then confirm. This needs **Allow adding events** for that account (a second, separate consent). If you add the same event again, the app warns you and asks before creating a second copy.
6. **Disconnect:** Calendar → Google calendars → *Disconnect*. Access is revoked with Google and the tokens are deleted. Events you already imported stay in OUR HOME.

## What OUR HOME never does

- Change or delete events in any Google Calendar. Import is read-only, and export only creates new events.
- Show one person's Google accounts, calendars or tokens to the other.
- Import anything without you picking it.
