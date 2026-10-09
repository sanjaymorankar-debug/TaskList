# TaskList

The task list for **bkesari.com**, served at **`/tasklist/`**. One table of every
task, with delays, reasons for delay, dependencies between tasks and a
timestamped comment history.

It is a small Node.js (Express) app with no build step, on PostgreSQL. The
bkesari.com hub (`bkesari-platform`) forwards `/tasklist/` to it and supplies the
shared top menu.

## What it does

**Every task has:** Sr No. (given automatically, never changed, never reused,
even after a delete) · Task Name (required) · Planned start / end · Actual
start / end · Reason for delay · Status (Not Started, In Progress, On Hold,
Completed, Cancelled) · Owner · Next action · Owner of next action · Dependencies
· Comments · and optionally a Project and a Description.

**Dates.** Planned end cannot be before planned start; actual end cannot be
before actual start. The server and the database both enforce this.

**Delay.** A task is delayed when, using today's date in IST:

| Case | Example (today 10 Oct) |
|---|---|
| Actual start is after planned start | planned 1 Oct, started 4 Oct → start +3 days |
| Actual end is after planned end | planned 10 Sep, finished 12 Sep → end +2 days |
| Planned start has passed and there is no actual start | planned 7 Oct, not started → start +3 days, counting |
| Planned end has passed, no actual end, task not Completed | planned 8 Oct → end +2 days, counting |

A planned date of *today* is not late yet. The two "still empty" cases do not
apply to a Completed or Cancelled task. When a task is delayed the form shows a
**Reason for delay** box. Saving is never blocked, but the list shows a red
**Reason missing** marker until one is given. If the dates are later corrected
so the task is on time, the reason is kept and the marker goes away. The
list has a "Delayed only" and a "Delayed, reason missing" filter.

**Dependencies.** A task can wait for any number of other tasks. It cannot wait
for itself, and loops (A waits for B waits for A, directly or through others)
are rejected with a message naming the loop. A task with an unfinished
dependency shows **Waiting**. Setting a task to In Progress or Completed while a
dependency is unfinished asks you to confirm, naming the unfinished tasks. The
task screen also lists which tasks wait for this one. Deleting a task that
others wait for asks first, then removes those links.

**Comments.** Any number per task. The server records the date and time; you
cannot type or change it. Times show in IST, e.g. `10 Oct 2026, 01:41 AM`. The
task screen shows the latest on top; the list shows each task's latest comment;
**Show history** lists them all oldest first. Comments cannot be edited or
deleted (the database refuses it too).

**The list** has search, filters for status, owner, owner of next action and
delay, sorting by Sr No. and by each date, and becomes one card per task on a
phone.

## Run it on a Mac

You need **Node.js 22.13 or later** (`node -v`) and **PostgreSQL**.

1. Install and start PostgreSQL (once):

   ```sh
   brew install postgresql@16
   brew services start postgresql@16
   ```

   If `psql` is not found afterwards, run
   `echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc` and open a new terminal.

2. Create the two databases (once). `tasklist_dev` holds your tasks;
   `tasklist_test` is emptied by every test run.

   ```sh
   createdb tasklist_dev
   createdb tasklist_test
   ```

3. Get the code and install (two packages, see *Dependencies* below):

   ```sh
   git clone https://github.com/sanjaymorankar-debug/TaskList.git
   cd TaskList
   npm install
   ```

4. Settings. Copy the example and set your own password in it:

   ```sh
   cp .env.example .env
   open -e .env      # set TASKLIST_PASSWORD; the database lines work as they are
   ```

5. Start it:

   ```sh
   npm start
   ```

   Open **http://localhost:3100/tasklist/** and log in with `TASKLIST_USER` /
   `TASKLIST_PASSWORD`. The tables are created on the first start.

6. Run the tests (they use `tasklist_test`, never `tasklist_dev`):

   ```sh
   npm test
   ```

### With the bkesari.com menu

The top menu belongs to the hub. Either:

- **Through the hub (as on the site):** in `bkesari-platform`, set
  `TASKLIST_ORIGIN=http://127.0.0.1:3100` and run `npm start` there, then open
  **http://localhost:3000/tasklist/**. The old address `/tasks/` redirects there.
- **TaskList on its own:** run the hub as above and set
  `TASKLIST_HUB_ORIGIN=http://localhost:3000` in TaskList's `.env`; TaskList then
  fetches `/shared/menu.js` from it. Without either, TaskList works, just with no
  top menu.

## Import from the old Task Tracker

The earlier tracker in `bkesari-platform/portal` keeps its data in MySQL (when
`DB_CLIENT=mysql`) or in a SQLite file (default: `bkesari-platform/portal/data/tasks.db`).
The import copies it into TaskList and leaves the old database untouched.

- Tasks are copied in their original order, so their Sr Nos follow it. They are
  numbered after any task already in TaskList.
- `title` becomes Task Name, `next_step` becomes Next action, and the old
  "current step" is added to the Description. Each task's full old row is kept
  in `tasks.legacy`.
- Comments keep their original date and time.
- Projects are copied by name. Their other fields and project comments are kept
  in `projects.legacy`, since TaskList has no project screen.
- **Safe to run twice:** what was copied is recorded and skipped next time; rows
  added to the old tracker since are picked up. It is all or nothing: if
  anything fails, nothing is saved.

Try it first with `--dry-run`, which shows the counts and saves nothing:

```sh
# from a SQLite file
npm run import-legacy -- --sqlite ../bkesari-platform/portal/data/tasks.db --dry-run
npm run import-legacy -- --sqlite ../bkesari-platform/portal/data/tasks.db

# from MySQL: set TASKLIST_IMPORT_MYSQL_DATABASE, _USER, _PASSWORD (and _HOST, _PORT) in .env
npm run import-legacy -- --mysql --dry-run
npm run import-legacy -- --mysql
```

Any row it had to adjust (an unknown status, an unreadable date) is listed as a
"Note" with the old value kept in `legacy`.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `TASKLIST_DATABASE_URL` | `postgres://localhost:5432/tasklist_dev` | The database |
| `TASKLIST_USER`, `TASKLIST_PASSWORD` | — | The login. If either is missing, **everyone is refused** |
| `TASKLIST_ALLOW_OPEN` | — | `1` = no login when the two above are unset. Own machine only |
| `TASKLIST_PORT` | `3100` | Port |
| `TASKLIST_HOST` | `127.0.0.1` | Address to listen on |
| `TASKLIST_HUB_ORIGIN` | — | Hub to fetch the shared menu from when run on its own |
| `TASKLIST_TEST_DATABASE_URL` | `postgres://localhost:5432/tasklist_test` | Tests only; name must end in `_test` |
| `TASKLIST_IMPORT_MYSQL_*` | — | The import from MySQL only |

## How it is put together

```
server.js            starts it: database, migrations, login, listen
src/app.js           routes and API
src/auth.js          the login, in one file so the central bkesari.com login can replace it
src/db.js            PostgreSQL pool and the migration runner
src/dependencies.js  the loop check
public/rules.js      statuses, delay rules, IST formatting; used by server AND browser
public/              the screen (index.html, app.js, app.css)
migrations/NNN_*.sql schema, applied in order on start; each safe to run twice
scripts/import-legacy.js  the one-off import
test/                node:test suites, against PostgreSQL
```

API, all under `/tasklist/api` and behind the login:

| Method and path | |
|---|---|
| `GET /meta` | statuses, today (IST), people, projects |
| `GET /tasks?q=&status=&owner=&next_action_owner=&delayed=1\|reason-missing&waiting=1&sort=sr_no\|planned_start\|planned_end\|actual_start\|actual_end&dir=asc\|desc` | the list |
| `GET /tasks/:srNo` | one task, with its comments latest first |
| `POST /tasks` | add (`comment` adds a first comment). `409 UNFINISHED_DEPENDENCIES` until resent with `"confirm": true` |
| `PUT /tasks/:srNo` | edit; same confirmation rule. `400 DEPENDENCY_LOOP` for a loop |
| `DELETE /tasks/:srNo` | delete. `409 HAS_DEPENDENTS` until `?confirm=1` |
| `GET /tasks/:srNo/comments?order=asc` | comments; latest first by default |
| `POST /tasks/:srNo/comments` | add `{ "body": "…" }`; the time is the server's |
| `GET /projects` | projects with task counts |

`GET /tasklist/healthz` answers `ok` without a login, for a process monitor.

## Dependencies

Kept to two, plus one optional:

- **express**: routing and static files. The same framework the hub uses.
- **pg**: the PostgreSQL client.
- **mysql2** (optional): only for importing from the old tracker's MySQL. If it
  fails to install, everything else still works.

Tests use Node's built-in test runner and `fetch`; the SQLite import uses Node's
built-in `node:sqlite`. No other packages.
