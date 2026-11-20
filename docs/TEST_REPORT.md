# Test report

Run on 2026-11-19 (after the lists / chat / dashboard redesign) with `npm test` (Vitest 5, Node 22, PostgreSQL 16 on localhost). The tests drive the real Hono API (`app.fetch`) against a real Postgres database, using two distinct user accounts per household and separate households for isolation tests. Google is replaced by an in-memory fake of the OAuth and Calendar v3 endpoints (`tests/google-mock.ts`). The fake records every request, so the tests can prove that no write calls reach a source calendar. AI is turned off (`AI_FEATURES=off`), so the built-in parsers are what gets tested.

**Result: 8 test files, 68 tests, all passing** (run again on 2026-11-20 after the Home audit: completed items, activity lines, card chats and styles, sub lists, @/# references, Board stickies for items, nicknames).

| Area | File |
|---|---|
| Migrations, schema constraints, authentication, sessions, CSRF, rate limiting, signup modes | `tests/auth.test.ts` |
| Scenarios A, B, G, H, archive / delete | `tests/scenarios.test.ts` |
| Scenarios C, D, E; natural-language parser with a fixed clock | `tests/calendar.test.ts` |
| Scenario F, groceries NEED→STOCK, comparisons, inventory, expenses; receipt parser, time zones, SSRF guard, link metadata | `tests/lists-receipts.test.ts` |
| Redesign: Toronto/CAD defaults; shared-unless-locked (locking moves chat, photos, subtasks; only the creator can lock); NEED/STOCK on all lists; search and filters; moving lists; repeating items; dated-item reminders; general chat, card references, conversation cards, private topics; yearly birthdays and important dates; opt-in Busy blocks; dashboard widget settings; data page privacy | `tests/redesign.test.ts` |
| Board, plans and custom lists: making, filling, archiving, restoring and deleting lists; private lists; locked items in shared lists; pins (running names, clamped positions, photos, locking, references, archive); plans (checklist, plan lists, links in and out, same-tag cards, archive prompt, archiving and restoring together); main-chat replies copied into cards (edits, deletions, unread counts, no copies into cards the replier can't open) | `tests/board-plans.test.ts` |
| Home audit: completed items stay until seen and can be undone (partner's line withdrawn); folded “added” lines; urgent / removed lines, never for private items; Important Dates / To do card chats, emoji and colour; built-in list styles; sub lists for events (yearly dates); @ cards vs # items; Board stickies for items (once per item, private follows the item, commit an idea to a list); nicknames visible only to their maker | `tests/home-audit.test.ts` |
| UI interaction (jsdom + Testing Library): the Share with US dialog | `tests/ui/share-dialog.test.tsx` |

## Detailed results

```
 ✓ tests/scenarios.test.ts > Scenario A — private shopping list, partial share > keeps ME private and shares exactly the selected items as copies 1046ms
 ✓ tests/scenarios.test.ts > Scenario A — private shopping list, partial share > moves an item explicitly and can remove an item from US 355ms
 ✓ tests/scenarios.test.ts > Scenario B — shared item with a discussion thread > notifies, threads replies and mentions on the jacket 430ms
 ✓ tests/scenarios.test.ts > Scenario B — shared item with a discussion thread > does not notify the partner about mentions inside a private item 241ms
 ✓ tests/scenarios.test.ts > Scenario G — task assignment and reminders > assigns “Book dentist” to YOU with a reminder; YOU completes it; ME sees it 333ms
 ✓ tests/scenarios.test.ts > Scenario G — task assignment and reminders > rolls recurring maintenance forward and keeps completion history 301ms
 ✓ tests/scenarios.test.ts > Scenario G — task assignment and reminders > rejects assigning a private task to the partner 236ms
 ✓ tests/scenarios.test.ts > Scenario G — task assignment and reminders > converts a reminder to an event and creates follow-up tasks from events 261ms
 ✓ tests/scenarios.test.ts > Scenario H — privacy enforcement at the API > rejects every unauthorized read and write 723ms
 ✓ tests/scenarios.test.ts > Scenario H — privacy enforcement at the API > protects attachments and categories across spaces 295ms
 ✓ tests/scenarios.test.ts > Archive, restore and confirmed deletion > archives by default and requires confirmation to delete shared data 332ms
 ✓ tests/calendar.test.ts > Scenario C — Google import into US (independent copies) > imports selected calendars from two accounts, edits copies, never touches Google 840ms
 ✓ tests/calendar.test.ts > Scenario C — Google import into US (independent copies) > reports a clear error when Google is not configured 203ms
 ✓ tests/calendar.test.ts > Scenario C — Google import into US (independent copies) > rejects a callback whose state belongs to another user 241ms
 ✓ tests/calendar.test.ts > Scenario D — export a YOU event into ME’s Google Calendar > previews, requires confirmation, creates one copy, warns on duplicates 489ms
 ✓ tests/calendar.test.ts > Scenario D — export a YOU event into ME’s Google Calendar > disconnects and revokes a connection while keeping imported copies 186ms
 ✓ tests/calendar.test.ts > Scenario E — natural-language event creation > identifies three separate drafts and never invents details 782ms
 ✓ tests/calendar.test.ts > Scenario E — natural-language event creation > associates events with household members and handles ambiguous numeric dates 265ms
 ✓ tests/calendar.test.ts > unit: natural-language parser with a fixed clock > resolves relative dates in the household time zone 8ms
 ✓ tests/calendar.test.ts > unit: natural-language parser with a fixed clock > extracts a location and duration without inventing an end time 7ms
 ✓ tests/lists-receipts.test.ts > Scenario F — grocery receipt > reviews lines, corrects one, adds to STOCK and completes matching NEED items 680ms
 ✓ tests/lists-receipts.test.ts > Scenario F — grocery receipt > stores an uploaded photo privately and asks for manual review when OCR is not configured 397ms
 ✓ tests/lists-receipts.test.ts > Groceries NEED → STOCK > moves purchased items to STOCK with an updated quantity, merges duplicates, and back 389ms
 ✓ tests/lists-receipts.test.ts > Groceries NEED → STOCK > supports home-improvement comparisons and decision states 365ms
 ✓ tests/lists-receipts.test.ts > Groceries NEED → STOCK > shows the partner view without private data 369ms
 ✓ tests/lists-receipts.test.ts > Groceries NEED → STOCK > records inventory and individual vs shared expenses with custom allocation 316ms
 ✓ tests/lists-receipts.test.ts > unit: parsers, time and URL safety > parses receipt text 1ms
 ✓ tests/lists-receipts.test.ts > unit: parsers, time and URL safety > matches receipt names to list items 0ms
 ✓ tests/lists-receipts.test.ts > unit: parsers, time and URL safety > converts household-local times across DST 3ms
 ✓ tests/lists-receipts.test.ts > unit: parsers, time and URL safety > blocks private network addresses for link previews 3ms
 ✓ tests/lists-receipts.test.ts > unit: parsers, time and URL safety > extracts product metadata 1ms
 ✓ tests/auth.test.ts > migrations > applies all migrations and is idempotent 18ms
 ✓ tests/auth.test.ts > migrations > creates the core relational tables with constraints 41ms
 ✓ tests/auth.test.ts > authentication & household membership > registers the primary user with a household, personal and shared space 328ms
 ✓ tests/auth.test.ts > authentication & household membership > invites the partner, who gets their own login and private space 320ms
 ✓ tests/auth.test.ts > authentication & household membership > rejects wrong passwords, short passwords, reused or invalid invites, and a third member 368ms
 ✓ tests/auth.test.ts > authentication & household membership > logs in and out with an HttpOnly session cookie 194ms
 ✓ tests/auth.test.ts > authentication & household membership > requires the CSRF header and same-origin for mutations 118ms
 ✓ tests/auth.test.ts > authentication & household membership > rate-limits repeated failed logins 802ms
 ✓ tests/auth.test.ts > authentication & household membership > first-user-only signup mode closes open registration once someone exists 83ms
 ✓ tests/ui/share-dialog.test.tsx > UI: Share with US dialog > previews a list, lets the user exclude items and edit one, and sends only the selection 554ms
 ✓ tests/ui/share-dialog.test.tsx > UI: Share with US dialog > makes moving explicit 83ms
 Test Files  6 passed (6)
      Tests  54 passed (54)
   Duration  24.70s (tests 66%, import 23%, environment 9%, transform 1%)
```

## Manual checks in the running app (`npm run dev`, two test accounts)

- **Scenario A:** as Nella, added three groceries to ME and shared two through the preview, deselecting "Birthday candles". As Zsolt, US groceries showed exactly the two shared items, marked "from Nella".
- **Scenario B:** as Nella, created "Jacket for Zsolt" in US (Clothing, intended for Zsolt, price, link) and posted "@Zsolt, do you like this one?". Zsolt's notifications showed the mention, the new item and the share. Opening the mention went straight to the item; Zsolt's reply appeared quoted in the same thread.
- **Scenario E:** pasted three bulleted events and got "3 calendar events identified." The dinner was flagged as ambiguous, because it was Thursday in the household time zone. The oil change kept "morning" as a hint with no time set and could not be saved until a date was chosen. The dentist appointment saved and appeared on 4 December at 14:00.
- **Scenario F (pasted text):** "Coffee beans" was matched to the NEED item, oat milk was offered as a merge into existing STOCK, and the unreadable line was flagged and blocked confirmation until skipped. After confirming, Coffee beans moved NEED→STOCK and oat milk became ×2.
- **Mobile (375 × 812):** bottom tab bar, groceries list, and the quantity sheet for "mark purchased → STOCK" all work. No console errors.

## Not covered by automated tests

- **Real Google:** the OAuth consent screens and the Calendar API were tested against the fake, not against Google itself. Do one real connect / import / export after configuring credentials (docs/GOOGLE_OAUTH.md).
- **Real Claude calls:** reading receipt photos and AI text → events were not exercised (no API key in the test environment). The fallback paths are tested.
- **The production stack:** Netlify Functions runtime, Netlify Database driver and Netlify Blobs were not run locally; locally the app uses `pg` and filesystem storage behind the same interfaces. Do a smoke test after the first deploy.
- **Browser coverage:** UI tests cover the share dialog only. The other screens were checked by hand in Chromium at desktop and mobile widths, not in Safari or Firefox.

## Redesign: manual checks in the browser (2026-11-19)

Checked in the running app as Nella with local demo data, at desktop (1440 px) and phone (375 px) widths:
- Dashboard: greeting and date, three list widgets in one row, important dates with "turns 35", to-dos mixed with dated items, today's hourly view with Nella / Zsolt columns and Zsolt's opt-in Busy block.
- Groceries: sections, NEED / STOCK tabs, Scan receipt button, comment button → quick chat; typing @ suggested a card, and the sent message showed a clickable card link.
- Item details: Reminders-style groups (date, time, urgent, repeat, early reminder, list, section, tags, subtasks, flag, priority, amount, privacy, photos).
- Chat: conversation cards, inline expansion, ongoing chat with card link.
- Calendar: day, week and month views. Data: spending, open topics, grocery habits, calendar load.

## Board, plans, lists and Paper theme: manual checks in the browser (2026-11-20)

Checked as Nella at 1440 px and 375 px wide:
- Paper theme on the dashboard, lists, chat, plan page and Board (Fraunces headings, Inter Tight text, terracotta accent).
- Made a list (“Books to read”) and added to it; it shows in the sidebar, on the dashboard and in the share page.
- Board: stickies, words, a moved sticky is saved; @-linking a pin from the side chat and clicking the link jumps to the pin; on a phone pins stack in one column.
- Plan page for “Dinner with Marco”: checklist, a plan list, the Linked strip, and a reply in Our chat copied into the plan's chat.
- Share page with a link inside shared text: the link is found, and “Home & Gadgets” adds it as an item.

Not checked: the share menu on a real Android or iPhone (needs the deployed HTTPS site), photo pins with real camera images, and two people dragging the same pin at once (the last move wins).

## Phone-first redesign: manual checks (2026-11-20)

At 375 px and on a desktop window: Home cards with previews and in-place expanding, the Groceries chat sliding in with its message box across the bottom, swiping an item to reveal Flag and Urgent, the calendar's week strip and event cards, the event pop-up (details, checklist, its list, chat), the Board as two columns of stickies on a phone, the notifications pop-up opening an item's chat in place. Not checked on a real phone.
