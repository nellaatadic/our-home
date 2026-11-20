# Feature checklist

**Layout (2026-11-20):** phone-first. One column on every screen (centred on computers), a bell with a notifications pop-up and search at the top, and five symbols at the bottom: Home, Board, Chat, Data, Settings. Lists and the calendar open from Home; details open as pop-ups on top of the current screen instead of new pages.

**Legend**

- ✅ **Works out of the box:** covered by automated tests and/or checked in the running app.
- 🔑 **Built, needs credentials:** fully implemented but switched off until you configure it.
- ⚠️ **Limitation:** works, with the restriction described.

## Accounts and privacy
| Feature | Status |
|---|---|
| Primary account creates the household; partner joins with a single-use, 7-day invite link | ✅ |
| Separate logins; editable display names | ✅ |
| Shared unless locked: lock icon when adding, Private switch in details; only the creator can lock; a locked item takes its chat, photos, subtasks and history with it | ✅ tested |
| Privacy enforced in every SQL query (unauthorized = 404); other households fully isolated | ✅ tested (Scenario H) |
| Sessions, CSRF protection, rate limiting, scrypt passwords, password change | ✅ |
| Household defaults: America/Toronto, CAD | ✅ tested |

## Lists (Groceries · Home & Gadgets · Shopping & Other · your own)
| Feature | Status |
|---|---|
| Make your own lists (name, icon, colour, sections; shared or private) from the sidebar or the dashboard; each gets a page, a dashboard widget and a place in the item sheet's List picker | ✅ tested |
| Archive a list (with everything in it) and restore it; delete it for good from the Archive (shared lists ask for confirmation) | ✅ tested |
| A locked item can stay in a shared list, hidden from your partner; everything in a private list is private | ✅ tested |
| Same structure for all three: NEED / STOCK, sections (categories), tap the circle to mark bought or ran out | ✅ tested |
| Search icon opens search plus filters (section, priority, added by, shared/private, flagged, urgent, has a date) and sorting | ✅ tested |
| Scan receipt button on Groceries (photo, PDF or pasted text → review → ticks off NEED items, adds to STOCK) | ✅ tested (Scenario F) |
| Reminders-style details: notes, URL, date, time, urgent, repeat, early reminder, list, section, tags, subtasks, flag, priority, quantity, store, price, photos | ✅ |
| Dated items send reminders (urgent ones to both of you); repeating items stay on NEED with the next date when bought | ✅ tested |
| Move an item to another list | ✅ tested |
| Link previews (title, image, price from page metadata), with SSRF protection | ✅ ⚠️ only sites that publish Open Graph / product metadata |

## Chat
| Feature | Status |
|---|---|
| Comment button next to every item: quick chat on the spot, with photos, files and links | ✅ |
| Chat page: every conversation as a small card (title only), expandable inline; one ongoing chat between you two on the right | ✅ tested |
| Type @ to mention your partner or link a whole card (list, event, plan, topic, sticky); type # to link one thing in a card (an item or to-do); links open the card | ✅ tested |
| Reply to a message in Our chat that tags a card, and the message and its replies are copied into that card's chat (marked “Our chat”; edits and deletions follow; not counted as unread twice) | ✅ tested |
| “Linked” strip above each card's chat: what it links to, where it was mentioned, and everything sharing its tags | ✅ tested |
| Topics: conversations not tied to an item (can be private) | ✅ tested |
| Messenger-style: your messages on the right without a name, theirs on the left with it; hold a message to reply, copy, edit or delete it; swipe it right to reply; read / unread, unread badge | ✅ checked in the browser |
| While typing on a phone, the top and bottom bars step aside so the chat and keyboard have the screen | ⚠️ checked in a phone-sized browser, not on a real phone |
| Notifications: mentions, replies, assignments, reminders, calendar changes, reactions, and one-line activity (“Zsolt marked Dish soap as urgent in @Groceries”; several additions folded into one line); per-type preferences | ✅ tested |
| Bell pop-up shows only what is new; opening and closing it clears them; “View full activity” appears when there is something | ✅ checked in the browser |
| Activity page: one compact line per thing (words left, time right); tap the words to go to the card on Home (and the # item in it), or “OK” to just note it | ✅ checked in the browser |
| Email / push notifications | ⚠️ not built (in-app only) |

## Board
| Feature | Status |
|---|---|
| A wall you can pan and zoom (pinch, trackpad, or the + / − buttons; the last view is remembered); stickies in 7 colours, photos and links; drag to move, pull the corner to resize | ✅ tested (API), checked in the browser |
| Zoomed out, stickies turn into small bubbles (#lamp); tap one to zoom back to it | ✅ checked in the browser |
| “+” suggests items not on the Board yet (#lamp #raincoat…); their stickies show the item's details (list, photo, notes, date, tags, chat). Stickies without an item are ideas (dashed) and can be added to a list later | ✅ tested |
| Pins are named “New sticky 1, 2…” unless you name them, can be @-mentioned in chat, have their own chat, and can be locked or archived | ✅ tested |
| The main chat sits beside the wall on a computer; on a phone it opens full screen from the chat button | ✅ checked in the browser |

## Plans
| Feature | Status |
|---|---|
| Every event opens as a pop-up (from the calendar's cards or Home) with details, people, a checklist (who and by when), lists of its own, tags, linked cards and its chat; adding a step or a list makes it a plan | ✅ tested |
| Plans show on the dashboard with checklist progress; checklist steps appear in To do & reminders | ✅ tested |
| The day after a plan ends it asks “Archive it?” (Not yet stops asking); archiving keeps its checklist and lists together and restores them together | ✅ tested |

## Share to OUR HOME
| Feature | Status |
|---|---|
| A share page that asks where a link or text should go: any list, a to-do, the calendar, the Board, Our chat or a plan's chat | ✅ checked in the browser |
| Android: installed app appears in the share menu (Web Share Target) | ⚠️ needs the deployed site (HTTPS); not tested on a device |
| iPhone: one-time Shortcut, steps in Settings (iOS does not let web apps join the share menu directly) | ⚠️ not tested on a device |
| Computer: bookmarklet in Settings | ✅ |

## Home
| Feature | Status |
|---|---|
| Greeting by the time on your phone; the date is a button to the calendar; every list as a card with a two-item preview; tap the card (or “+ N more”) to open it in place, tap its name or emoji for its page; last update time; dashed card to make a new list | ✅ checked in the browser |
| Important Dates and To do & Reminders cards: add new, their own chat, their own emoji and colour (palette button when open; also for lists) | ✅ tested |
| Completed: ticked items stay crossed off under “Completed” for a while; tap to undo. They go once the partner has seen the “completed” line (or after 15 minutes for the one who ticked it) | ✅ tested |
| The same item twice on a list (e.g. a second Milk) gets a ⋯ mark: probably for an event or someone, not the fridge | ✅ checked in the browser |
| Change your partner's name on certain days (“Big Friday” every Friday, “Birthday Boy” on 11 December), set in Settings; only you see it | ✅ tested |
| Each card has one chat (“@groceries”) that fills the right half; the greeting, headings and bottom bar make room while it is open; grocery items have no chat of their own, other lists' items keep theirs (with a short summary of the item above it) | ✅ tested |
| Swipe an item right for Details and Urgent, left for “# Sub list” (put it on an event's own list, or say who it is for) and Remove (with Undo); hold it to see both sides; tap its name to fix a typo | ✅ checked in the browser |

## Dashboard (earlier layout)
| Feature | Status |
|---|---|
| Row 1: greeting and date, then Groceries, Home & Gadgets, Shopping & Other widgets: add (shared or locked), items shown (3–12), size (S/M/L), hide, expand to full list | ✅ tested |
| Row 2: Important dates (birthdays, anniversaries, social, holidays; yearly repeats), To do & reminders (to-dos plus dated items), Today (hourly, both schedules) | ✅ tested |

## Calendar
| Feature | Status |
|---|---|
| Day (hourly, one column per person), week (hourly) and month views; shared vs private distinguished | ✅ |
| Birthdays and anniversaries repeat every year | ✅ tested |
| Partner's private time as anonymous Busy blocks, only if they opt in (Settings → Calendar) | ✅ tested |
| Manual events (all-day, multi-day, time not set, participants, category, "about" person) | ✅ |
| Text → event drafts (bullets / sentences, several events), ambiguity questions, no invented details | ✅ tested (Scenario E), built-in parser |
| AI-assisted text → events | 🔑 `ANTHROPIC_API_KEY` |
| Connect several Google accounts per person; choose calendars; disconnect and revoke | 🔑 Google OAuth (tested against a fake Google: Scenarios C and D) |
| Import from today to +6 months; private events imported as "Busy" only; no duplicates; never writes to Google | 🔑 tested |
| Refresh: new / changed / removed events with field-level differences; local edits kept unless you choose otherwise | 🔑 tested |
| Export a US event into *my* Google Calendar: edit, choose calendar, preview, confirm, duplicate warning | 🔑 tested |
| Recurring Google events | ⚠️ imported as individual occurrences (each one independent); the recurrence rule is stored for reference |

## Data analysis
| Feature | Status |
|---|---|
| Spending: last 6 months, by category, who paid, who owes whom (from confirmed receipts and shared expenses) | ✅ tested |
| Grocery habits: bought most often, ran out most often, average days from list to bought | ✅ tested |
| Open topics: open / overdue to-dos, urgent and flagged items, decisions, chats where your partner spoke last | ✅ |
| Calendar load: events per week for the next 8 weeks | ✅ |
| Removed from the interface (data is kept): tasks page, inventory, expenses page, ideas page, YOU page | ⚠️ by request |

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
