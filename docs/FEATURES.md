# Feature checklist

**Legend**

- ✅ **Works out of the box:** covered by automated tests and/or checked in the running app.
- 🔑 **Built, needs credentials:** fully implemented but switched off until you configure it.
- ⚠️ **Limitation:** works, with the restriction described.

## Accounts, spaces and privacy
| Feature | Status |
|---|---|
| Primary account creates the household; partner joins with a single-use, 7-day invite link | ✅ |
| Separate logins; display name editable (shown as YOU to the partner) | ✅ |
| ME / YOU / US spaces; privacy enforced in every SQL query (unauthorized = 404) | ✅ tested (Scenario H) |
| Other households fully isolated; sign-up closes after the first user (`SIGNUP_MODE`) | ✅ |
| Sessions, CSRF protection, rate limiting, scrypt passwords, password change | ✅ |
| Share single items or whole lists: preview, select or deselect, edit, duplicate warnings | ✅ tested (Scenario A + UI test) |
| Copy by default; explicit move; "Remove from US" (archives the shared copy) | ✅ |
| Provenance: original owner, shared by, shared at, "edited since sharing", original changed since sharing | ✅ |
| Household limited to two members | ✅ |

## Lists
| Feature | Status |
|---|---|
| Groceries NEED / STOCK with quantity, unit, category, priority, notes, assignee, store, link, price, images | ✅ |
| Default food and household categories, plus custom categories with colours; consistent priority colours | ✅ |
| Filter and sort by category, priority, person; several lists per space | ✅ |
| Mark purchased → STOCK (with quantity, or automatically per household setting); merges into an existing STOCK entry; "ran out" → NEED | ✅ |
| STOCK expiry dates and storage location | ✅ |
| Home improvement: room, dimensions, colour/material, link with preview, several images, status, target date | ✅ |
| Side-by-side comparison of alternatives; mark the preferred option | ✅ |
| Ideas / gifts / clothes / trips / restaurants: type, intended person (household member or anyone), tags, filters | ✅ |
| Link previews (title, image, price from page metadata), with SSRF protection | ✅ ⚠️ only sites that publish Open Graph / product metadata; otherwise the link is kept and you can add a photo |

## Decisions and conversations
| Feature | Status |
|---|---|
| Decision states (idea → considering → discussing → approved → purchased / rejected) and purchase stages | ✅ |
| Quick reactions (❤️ 👍 🤔 👎); "waiting for your opinion" on the dashboard | ✅ |
| A thread on every item, task, event and inventory entry: replies, @mentions (@Name, @ME, @YOU), editing and deleting your own messages, attachments, read / unread | ✅ tested (Scenario B) |
| Notifications: mentions, replies, shares, assignments, reminders, calendar changes, decisions; mark read; per-type preferences | ✅ |
| Email / push notifications | ⚠️ not built (in-app only, as allowed by the spec) |

## Tasks and maintenance
| Feature | Status |
|---|---|
| Tasks with optional date and time, priority, ME / YOU / BOTH, six statuses, reminder, recurrence, details, discussion | ✅ tested (Scenario G) |
| Recurring maintenance rolls forward on completion, with completion history | ✅ |
| Reminder → calendar event; event → follow-up tasks | ✅ |
| Reminders delivered by a scheduled function (every 15 min) and when the app is opened | ✅ |

## Calendar
| Feature | Status |
|---|---|
| Month and agenda views; private vs shared visibly distinguished; household time zone | ✅ |
| Manual events (all-day, multi-day, time not set, participants, category, "about" person) | ✅ |
| Text → event drafts (bullets / sentences, several events), ambiguity questions, no invented details | ✅ tested (Scenario E), built-in parser |
| AI-assisted text → events | 🔑 `ANTHROPIC_API_KEY` |
| Connect several Google accounts per person; choose calendars; disconnect and revoke | 🔑 Google OAuth (tested against a fake Google: Scenarios C and D) |
| Import from today to +6 months; private events imported as "Busy" only; no duplicates; never writes to Google | 🔑 tested |
| Refresh: new / changed / removed events with field-level differences; local edits kept unless you choose otherwise | 🔑 tested |
| Export a US event into *my* Google Calendar: edit, choose calendar, preview, confirm, duplicate warning | 🔑 tested |
| Recurring Google events | ⚠️ imported as individual occurrences (each one independent); the recurrence rule is stored for reference |

## Receipts, inventory and expenses
| Feature | Status |
|---|---|
| Upload a receipt photo or PDF (stored privately), or paste receipt text | ✅ |
| Review screen: edit names, quantities, prices, categories; uncertain lines flagged and blocking; matching NEED items offered as completed; merge into existing STOCK | ✅ tested (Scenario F) |
| Automatic reading of receipt photos and PDFs | 🔑 `ANTHROPIC_API_KEY` (without it, the photo is stored and you enter the lines by hand or paste text) |
| Room-based inventory with brand, model, dimensions, purchase date, price, warranty, manual link, images, notes | ✅ |
| Expenses: individual or shared, equal or custom split, who paid vs who is responsible, totals by category, link to receipt | ✅ |

## Organisation and data
| Feature | Status |
|---|---|
| Global search across items, notes, categories, tags, tasks, events, inventory, expenses, conversation text; respects privacy | ✅ tested |
| Favourites, recently viewed, archive and restore; permanent delete only after archiving (and confirmation for shared data) | ✅ |
| Activity history per record and on the dashboard | ✅ |
| Customizable dashboard sections | ✅ |
| Responsive desktop, tablet and mobile (bottom tab bar, bottom sheets, camera capture for photos and receipts) | ✅ checked at 375 px and desktop widths |

## External services and credentials

| Service | Needed for | Variables | Required? |
|---|---|---|---|
| Netlify (hosting, Functions, Scheduled Functions) | Everything | none (connect the `our-home` repo only) | Yes |
| Netlify Database (Postgres) | All data | `NETLIFY_DB_URL`, set automatically | Yes (credit-based Netlify plan) |
| Netlify Blobs | Photos, attachments, receipts | none on Netlify | Yes (included) |
| Encryption key | Google token encryption | `TOKEN_ENCRYPTION_KEY` | Yes if using Google |
| Google Cloud OAuth client + Calendar API | Calendar import / export | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL` | Optional |
| Anthropic API | Receipt photo reading, AI text → events | `ANTHROPIC_API_KEY` (optional `ANTHROPIC_MODEL`) | Optional |
