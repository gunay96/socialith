# Page management — operator guide

How to set up and run the Page Network day to day. Design: `PAGE_NETWORK_ARCHITECTURE.md`. Everything here is a record in Socialith's database: nothing on this screen publishes, renders media or contacts a social platform.

Who can do what: **everyone** can read; **administrators** (ADMIN, OWNER) create, edit, archive, group, link accounts and assign pages to campaigns. Editors and above also see internal notes and the Upload-Post profile name; viewers do not.

## 1. Set up, in this order

1. **Categories** (*Page Network → Page Categories*). Click **Add starter categories** for Motivation, Football, Humor / Memes, Relationships, Lifestyle and Entertainment (adding twice, or having a category of the same name, never duplicates or overwrites), and/or **New category** for your own. Fill in the language, the **default editorial style** and the content/visual preferences: every page of the category inherits them.
2. **Accounts** are connected in Upload-Post and enabled as *publishing destinations* (*Upload-Post → Accounts*). The Page Network never creates an account.
3. **Pages** (*New page*): name, platform, username (public handle), profile URL, category, description, target audience, language, editorial identity, notes; optionally pick the publishing account right away. One page record per handle and platform.
4. **Link the account** (page details or *Account Mapping*) if you did not at creation.
5. **Groups** (*Page Groups*): e.g. MOTIVATION NETWORK with Motivation Page 01-03. Add and remove pages any time; a page can be in several groups.
6. **Identity** (page → *Editorial identity*): only what is *different* for this page.
7. **Campaigns** (campaign screen → *Pages in this campaign*): assign pages and/or groups.

## 2. Editorial identity: inherit, then override

Each page has its own editorial profile. **Blank means inherit** from the category; anything you fill in overrides it for this page only. Next to every field a tag says where today's value comes from (`page`, `group`, `category`, `default`, `unset`), and the blank field's placeholder shows what it currently resolves to.

| You want | Do |
|---|---|
| a page to look like its category | leave everything blank |
| one page to differ in one thing (e.g. aspect ratio 4:5) | fill only that field |
| a category change to reach all pages | edit the category; pages with their own value for that field keep theirs |
| to go back to inheriting | **Remove all overrides** (or clear the field) |
| to see the effect of a group's preferences | *Preview with a group's preferences* (page over group over category) |

Fields: editorial identity/style; formats; topics, topics to avoid, terms that must not appear; longest text; facts must be verified; visual style, fonts, colors (hex), text position, aspect ratio; guidelines; repeat threshold and look-back; what happens when a rule is broken. Formats, fonts, colors, positions and aspect ratio are **preferences only** — no media is made and no text is placed automatically until Media Packs (Phase 5).

### Page rules and the text checker

*Check a text against this page* tests a caption without saving anything. The same checks run on every publication whose destination serves the page:

| Result | Meaning | What to do |
|---|---|---|
| warning: too long / avoided term / not original | the text breaks a rule you set for this page | reword; or change the rule; a warning never blocks |
| **error** (only if the rule is set to *Block*) | submitting/scheduling is refused until fixed | reword or relax the rule |
| info: facts must be verified | a reminder for the approver; Socialith cannot verify facts | check names, scores and dates yourself |

*Not original* compares the text with the **same page's** last N posts (default 30, 0 = off). It is different from the Publishing Center's cross-page guard (same media with the same text on several pages), which still applies.

## 3. Account states

| State | Meaning | Do |
|---|---|---|
| Ready to publish | connected and healthy | — |
| Reconnect required | Upload-Post says the authorization expired | reconnect it in Upload-Post, then *Upload-Post → Sync now* |
| Disconnected | the account is disconnected, left its Upload-Post profile, or its destination was switched off | reconnect/re-enable it; or unlink it and link another |
| Unavailable | profile removed or blocked, a different account is behind the handle, wrong platform, or a demo account | read the reason shown; resolve at Upload-Post |
| No publishing destination | nothing linked | link an account |

The state is read live from the last synchronization and the *Last synchronized* time is shown; the Page Network never shows an account as connected unless the provider data says so.

**Linking is refused** when the destination is of another platform, is a demo/seed account, already serves another page (the message names it — unlink it there first), or belongs to an individual **creator** (creators and thematic pages are separate: remove the creator assignment first if the account really is a page). If a page's Upload-Post *profile* is mapped to a different page (the Phase 2, brand-level mapping), a note says so; it is never changed automatically.

## 4. Archiving

Archive instead of deleting. A page keeps its history, groups and destination link but becomes read-only, leaves campaign work and active counts; *Restore* brings it back. Archived categories stay on their pages but cannot be chosen again. To free an account that an archived page still holds, unlink it on that page (restore → unlink).

## 5. Campaigns

A campaign's pages = those assigned directly + the members of its assigned groups (archived groups do not count). A page reachable both ways is listed once with both reasons. Pick a **page category** on the campaign screen to see only the content aimed at pages of that category. Assigning pages records who the campaign is for; publishing still goes through the Publishing Center, per destination, approved.

## 6. Troubleshooting

| You see | Cause / fix |
|---|---|
| "Incomplete page profile" | a page from Phase 2 (a name only): open it and set platform, username and category |
| "A page with that username is already registered on this platform" | the handle is taken (also by an archived page — restore that one instead) |
| "That destination already belongs to the page …" | unlink it from that page first |
| "The category … is archived" | restore it or choose another |
| "This page is archived" on edit | restore it first |
| A group preference seems ignored | group preferences apply only when a group is chosen (preview/check); the page's own values always win |
