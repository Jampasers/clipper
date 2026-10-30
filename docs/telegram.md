# Telegram bot

The bot is a separate long-polling process (`pnpm telegram`, entry
`src/telegram/entry.ts`). It is **off** until `TELEGRAM_BOT_TOKEN` is set, and only the
numeric user id in `TELEGRAM_ALLOWED_USER_ID` can use it (`authorizationCheck` rejects
everyone else, including groups).

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) → move the token into
   `TELEGRAM_BOT_TOKEN`.
2. Message the bot once; get your numeric id from @userinfobot (or the bot's "Not
   authorized" log line) → put it in `TELEGRAM_ALLOWED_USER_ID`.
3. `pnpm telegram` (output tag `TELEGRAM`). The web server is not required to run the bot,
   but they share the same SQLite DB and storage, so the pipeline, jobs and renders are
   visible to both.

## Usage

| Action | What happens |
| --- | --- |
| Send a **video** (mp4) ≤ 20 MB | Downloads via Bot `getFile`, creates a project, runs the pipeline (transcribe → analyze → clips → score), streams progress back. |
| `/start`, `/help` | Command reference. |
| `/projects` | Recent projects with status. |
| `/clips` | Inline buttons for the clip candidates of the latest READY project (select / score / change order). |
| `/render` | Renders all **selected** clips (kind `telegram`) and sends the files back. |
| `/health` | Same health checks as the dashboard. |

## Limits & behaviour

- Bot `getFile` downloads are capped at **20 MB** by the Telegram API; bigger videos must
  go through the web dashboard. (The guard is 20 MB, not 20 GB.)
- Progress updates edit the same message every ~4 s until the project becomes
  `READY` (with the candidate buttons) or `FAILED`.
- Rendering is queued like any other job; `/render` enqueues `render_final` jobs of kind
  `telegram` and the bot sends the output files to the chat.

## Security notes

- The bot never executes model output; it only posts status and clip buttons.
- The configured user id is checked on every update; keeping `TELEGRAM_ALLOWED_USER_ID`
  single-valued is the whole authorization model — don't use a group chat id.
