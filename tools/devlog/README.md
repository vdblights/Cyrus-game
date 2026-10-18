# Dev log on X

The game's X account gets two kinds of post, and both are drafts until you
say otherwise:

- **Updates.** Every pull request merged into `main` gets a draft post about
  it, left as a comment on the PR by the `Devlog` workflow
  (`.github/workflows/devlog.yml`).
- **Everything else.** Three times a week (Monday, Wednesday and Friday,
  16:00 UTC) the `Devlog schedule` workflow drafts a post on another topic,
  as an issue labelled `devlog`. The topics take turns: a transmission from
  Carrow, a look behind a mechanic (one of the lessons in `CLAUDE.md`), a tip
  from HALCYON (the loading screen's field notes), and a city to try by its
  seed. Scheduled posts need `ANTHROPIC_API_KEY`. Run that workflow by hand
  to get one now, and pick a topic if you like.

## The voice

[`voice.md`](voice.md) is how the account sounds, and Claude reads it for
every post. There are two registers: a dry first-person **diary** for posts
about building the game, and **radio** for posts from inside Carrow, in
HALCYON's voice, drawing only on the game's story. Edit the file to change
how the account sounds; the next post follows it. Claude is also shown the
account's last ten drafts, so it doesn't repeat itself.

## How a post goes out

1. A draft appears: a comment on a merged PR, or a new `devlog` issue.
2. Edit it if you want different words. The text in the box is what gets
   posted.
3. Open **Actions → Devlog → Run workflow**, enter the PR or issue number,
   tick **post**, and run it. The draft changes to a link to the post, and a
   draft issue closes.

To drop a scheduled draft, close its issue. For a PR, untick **post** to
draft again, which replaces the draft (or fill in **text** to set it by
hand). Anything already posted is refused unless you fill in **text**, so
nothing is posted twice by accident. Label a PR `no-devlog` to skip it;
Dependabot's are skipped anyway.

**Fully automatic:** set the repository variable `DEVLOG_AUTOPOST` to `true`
and every draft is posted the moment it is written, merges and scheduled
posts alike. Unset it to go back. To stop the scheduled posts, disable the
`Devlog schedule` workflow in the Actions tab.

## Setting it up

All of this is in your own accounts; none of it goes in the repo or in chat.

### 1. The X account and its keys

1. Create the X account for the game (for example `@ashfallgame`) and sign in
   as it.
2. Go to <https://developer.x.com>, sign up for a developer account as that
   account, and check what the current plan allows: you need to be able to
   create posts through the API.
3. In the developer portal, create a Project and an App inside it.
4. In the App's **User authentication settings**, set app permissions to
   **Read and write** (type: Web App or Automated App/Bot; any callback URL,
   such as your game's URL, is fine since this never signs anyone in).
5. In the App's **Keys and tokens**, copy the **API Key and Secret**, then
   generate an **Access Token and Secret**. Generate the access token *after*
   step 4, or it will be read-only and posting fails with a 403.

### 2. Into GitHub

In the repo, **Settings → Secrets and variables → Actions**:

| Secrets | From |
| --- | --- |
| `X_API_KEY` | API Key |
| `X_API_SECRET` | API Key Secret |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |
| `ANTHROPIC_API_KEY` | optional, from <https://console.anthropic.com> |

| Variables (all optional) | What |
| --- | --- |
| `DEVLOG_LINK` | the link every post ends with, such as where the game is hosted; the repo if unset |
| `DEVLOG_HANDLE` | the account's handle without `@`, for the link back to each post |
| `DEVLOG_AUTOPOST` | `true` to post every draft without asking |

Without `ANTHROPIC_API_KEY` an update's draft is a template off the PR's
title ("ASHFALL dev log: …") and there are no scheduled posts. With it,
Claude writes every draft in the voice, and the template is the update's
fallback. A draft costs a few cents of API use.

`DEVLOG_LINK` is worth setting to wherever the game is played: the seed
posts only run with it, because they link straight to one city.

## Checks

```bash
cd tools/devlog && npm ci && npm test
```

Nothing in them reaches GitHub, X or Claude. The signing is checked against
the worked example in X's OAuth 1.0a documentation; CI runs them on every PR.
