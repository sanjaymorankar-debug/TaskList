#!/usr/bin/env node
/**
 * One-off import from the earlier Task Tracker (bkesari-platform portal/) into
 * TaskList's PostgreSQL database.
 *
 *   npm run import-legacy -- --sqlite /path/to/bkesari-platform/portal/data/tasks.db
 *   npm run import-legacy -- --mysql          (reads TASKLIST_IMPORT_MYSQL_* settings)
 *   add --dry-run to see what would be copied without writing anything.
 *
 * What it copies:
 *   - each project, by name, with its other fields and its comments kept in
 *     projects.legacy (TaskList has no project screen to show them on);
 *   - each task, in the order it was created (old id order), so its Sr No.
 *     follows the original order. title -> Task Name, next_step -> Next action;
 *     the old "current step" is added to the description, and the full old row
 *     is kept in tasks.legacy;
 *   - each task comment with its original time.
 *
 * Safe to run twice: every copied row is recorded in legacy_import, and a row
 * already recorded is skipped. Rows added to the old tracker after a first run
 * are picked up by the next. It never changes or deletes anything in the old
 * database, and the whole import is one transaction: all or nothing.
 */
const path = require('node:path');
const rules = require('../public/rules.js');
const { createPool, databaseUrl, describeUrl, migrate, transaction } = require('../src/db');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Old "YYYY-MM-DD HH:MM:SS" (UTC, as the old app wrote it) to an ISO moment, or null. */
function legacyMoment(value) {
  if (!value) return null;
  const s = String(value).trim().replace(' ', 'T');
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function legacyDate(value) {
  if (!value) return null;
  const s = String(value).trim().slice(0, 10);
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
}

function text(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s || null;
}

async function readSqlite(file) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error(`Reading the SQLite file needs Node 22.13 or later (this is ${process.version}).`);
  }
  const db = new DatabaseSync(path.resolve(file), { readOnly: true });
  try {
    const all = (sql) => db.prepare(sql).all();
    const tables = new Set(all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
    if (!tables.has('tasks')) throw new Error(`${file} has no tasks table; is it the Task Tracker database?`);
    return {
      projects: tables.has('projects') ? all('SELECT * FROM projects ORDER BY id') : [],
      tasks: all('SELECT * FROM tasks ORDER BY id'),
      comments: tables.has('comments') ? all('SELECT * FROM comments ORDER BY id') : [],
    };
  } finally {
    db.close();
  }
}

async function readMysql(env) {
  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch {
    throw new Error('Reading from MySQL needs the mysql2 package: run `npm install` first.');
  }
  for (const key of ['TASKLIST_IMPORT_MYSQL_DATABASE', 'TASKLIST_IMPORT_MYSQL_USER']) {
    if (!env[key]) throw new Error(`Set ${key} (and TASKLIST_IMPORT_MYSQL_PASSWORD, _HOST, _PORT as needed).`);
  }
  const conn = await mysql.createConnection({
    host: env.TASKLIST_IMPORT_MYSQL_HOST || 'localhost',
    port: Number(env.TASKLIST_IMPORT_MYSQL_PORT || 3306),
    database: env.TASKLIST_IMPORT_MYSQL_DATABASE,
    user: env.TASKLIST_IMPORT_MYSQL_USER,
    password: env.TASKLIST_IMPORT_MYSQL_PASSWORD,
    dateStrings: true, // keep DATE/DATETIME exactly as stored
    timezone: 'Z',
    charset: 'utf8mb4',
  });
  try {
    const q = async (sql) => (await conn.query(sql))[0];
    return {
      projects: await q('SELECT * FROM projects ORDER BY id'),
      tasks: await q('SELECT * FROM tasks ORDER BY id'),
      comments: await q('SELECT * FROM comments ORDER BY id'),
    };
  } finally {
    await conn.end();
  }
}

/**
 * Copies `legacy` ({ projects, tasks, comments } rows as the old schema has
 * them) into the TaskList database. `source` names where they came from
 * ('sqlite' or 'mysql') and keys the record of what was already copied.
 *
 * Returns counts of what was added and skipped, and any warnings.
 */
async function importRows(pool, legacy, { source, dryRun = false } = {}) {
  const report = {
    projects: { added: 0, skipped: 0 },
    tasks: { added: 0, skipped: 0 },
    comments: { added: 0, skipped: 0 },
    projectComments: { added: 0, skipped: 0 },
    warnings: [],
    dryRun,
  };
  const warn = (msg) => report.warnings.push(msg);

  const ROLLBACK = Symbol('dry run');
  try {
    await transaction(pool, async (db) => {
      // One import at a time, and no task added from the app while it runs,
      // so the copied tasks get consecutive Sr Nos in their original order.
      await db.query('LOCK TABLE legacy_import, tasks IN SHARE ROW EXCLUSIVE MODE');
      const seq = (await db.query("SELECT pg_get_serial_sequence('tasks', 'sr_no') AS name")).rows[0].name;
      const seqBefore = (await db.query(`SELECT last_value, is_called FROM ${seq}`)).rows[0];
      const done = new Map();
      for (const r of (await db.query('SELECT kind, legacy_id, new_id FROM legacy_import WHERE source = $1', [source])).rows) {
        done.set(`${r.kind}:${r.legacy_id}`, r.new_id);
      }
      const record = async (kind, legacyId, newId) => {
        await db.query('INSERT INTO legacy_import (source, kind, legacy_id, new_id) VALUES ($1,$2,$3,$4)',
          [source, kind, legacyId, newId]);
        done.set(`${kind}:${legacyId}`, newId);
      };

      /* projects */
      for (const p of legacy.projects) {
        if (done.has(`project:${p.id}`)) { report.projects.skipped++; continue; }
        const name = text(p.name) || `Project ${p.id}`;
        const details = {
          legacy_id: Number(p.id), owner: text(p.owner), status: text(p.status),
          planned_start: legacyDate(p.planned_start), planned_end: legacyDate(p.planned_end),
          actual_start: legacyDate(p.actual_start), actual_end: legacyDate(p.actual_end),
          current_step: text(p.current_step), next_step: text(p.next_step),
          created_at: legacyMoment(p.created_at), updated_at: legacyMoment(p.updated_at), comments: [],
        };
        const row = await db.query(
          'INSERT INTO projects (name, description, legacy, created_at) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now())) RETURNING id',
          [name, text(p.description), details, details.created_at]);
        await record('project', p.id, row.rows[0].id);
        report.projects.added++;
      }

      /* tasks, oldest first, so Sr Nos follow the original order */
      for (const t of legacy.tasks) {
        if (done.has(`task:${t.id}`)) { report.tasks.skipped++; continue; }
        const label = `old task ${t.id}`;
        const legacyRow = {};
        for (const [k, v] of Object.entries(t)) legacyRow[k] = v === undefined ? null : v;
        const dates = {};
        for (const key of ['planned_start', 'planned_end', 'actual_start', 'actual_end']) {
          dates[key] = legacyDate(t[key]);
          if (t[key] && !dates[key]) warn(`${label}: ${key} "${t[key]}" is not a date; left empty (kept in legacy).`);
        }
        if (dates.planned_start && dates.planned_end && dates.planned_end < dates.planned_start) {
          warn(`${label}: planned end is before planned start; planned end left empty (kept in legacy).`);
          dates.planned_end = null;
        }
        if (dates.actual_start && dates.actual_end && dates.actual_end < dates.actual_start) {
          warn(`${label}: actual end is before actual start; actual end left empty (kept in legacy).`);
          dates.actual_end = null;
        }
        let status = text(t.status) || 'Not Started';
        if (!rules.STATUSES.includes(status)) {
          warn(`${label}: status "${status}" is not one of TaskList's; set to Not Started (kept in legacy).`);
          status = 'Not Started';
        }
        const currentStep = text(t.current_step);
        const description = [text(t.description), currentStep && `Current step (from Task Tracker): ${currentStep}`]
          .filter(Boolean).join('\n\n') || null;
        let projectId = null;
        if (t.project_id !== null && t.project_id !== undefined) {
          projectId = done.get(`project:${t.project_id}`) || null;
          if (!projectId) warn(`${label}: its project ${t.project_id} no longer exists; imported without a project.`);
        }
        const created = legacyMoment(t.created_at);
        const updated = legacyMoment(t.updated_at);
        const row = await db.query(
          `INSERT INTO tasks (name, description, project_id, status, owner, planned_start, planned_end,
                              actual_start, actual_end, next_action, legacy, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                   COALESCE($12::timestamptz, now()), COALESCE($13::timestamptz, $12::timestamptz, now()))
           RETURNING sr_no`,
          [text(t.title) || text(t.name) || `Task ${t.id}`, description, projectId, status, text(t.owner),
            dates.planned_start, dates.planned_end, dates.actual_start, dates.actual_end, text(t.next_step),
            { source, row: legacyRow }, created, updated]);
        await record('task', t.id, row.rows[0].sr_no);
        report.tasks.added++;
      }

      /* comments, keeping their original times */
      for (const c of legacy.comments) {
        const kind = c.entity_type === 'project' ? 'project-comment' : 'comment';
        const counter = kind === 'comment' ? report.comments : report.projectComments;
        if (done.has(`${kind}:${c.id}`)) { counter.skipped++; continue; }
        const body = text(c.body);
        const at = legacyMoment(c.created_at);
        if (!body) { warn(`old comment ${c.id}: empty; skipped.`); continue; }
        if (!at) warn(`old comment ${c.id}: time "${c.created_at}" unreadable; given the import time.`);
        if (kind === 'comment') {
          const srNo = done.get(`task:${c.entity_id}`);
          if (!srNo) { warn(`old comment ${c.id}: its task ${c.entity_id} no longer exists; skipped.`); continue; }
          const row = await db.query(
            'INSERT INTO comments (task_sr_no, body, created_at) VALUES ($1,$2,COALESCE($3::timestamptz, now())) RETURNING id',
            [srNo, body, at]);
          await record(kind, c.id, row.rows[0].id);
        } else {
          const projectId = done.get(`project:${c.entity_id}`);
          if (!projectId) { warn(`old comment ${c.id}: its project ${c.entity_id} no longer exists; skipped.`); continue; }
          await db.query(
            `UPDATE projects SET legacy = jsonb_set(COALESCE(legacy, '{}'::jsonb), '{comments}',
                    COALESCE(legacy->'comments', '[]'::jsonb) || jsonb_build_array($2::jsonb))
              WHERE id = $1`,
            [projectId, { legacy_id: Number(c.id), body, created_at: at }]);
          await record(kind, c.id, projectId);
        }
        counter.added++;
      }

      if (dryRun) {
        // A sequence is not rolled back with the transaction. Put it back while
        // the lock is still held, so a dry run uses up no Sr Nos.
        await db.query('SELECT setval($1::regclass, $2, $3)', [seq, seqBefore.last_value, seqBefore.is_called]);
        throw ROLLBACK;
      }
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
  return report;
}

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--mysql') args.mysql = true;
    else if (a === '--sqlite') args.sqlite = argv[++i];
    else if (a.startsWith('--sqlite=')) args.sqlite = a.slice('--sqlite='.length);
    else if (a === '--help' || a === '-h') args.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.sqlite && !args.mysql) || (args.sqlite && args.mysql)) {
    console.log(`Usage:
  npm run import-legacy -- --sqlite <path to the old tasks.db> [--dry-run]
  npm run import-legacy -- --mysql [--dry-run]
      with TASKLIST_IMPORT_MYSQL_HOST, _PORT, _DATABASE, _USER, _PASSWORD set
Copies into TASKLIST_DATABASE_URL (default ${databaseUrl({})}).`);
    process.exit(args.help ? 0 : 1);
  }
  const source = args.sqlite ? 'sqlite' : 'mysql';
  const legacy = args.sqlite ? await readSqlite(args.sqlite) : await readMysql(process.env);
  console.log(`Read from the old ${source} database: ${legacy.projects.length} projects, `
    + `${legacy.tasks.length} tasks, ${legacy.comments.length} comments.`);

  const url = databaseUrl();
  const pool = createPool(url);
  try {
    await migrate(pool);
    console.log(`Importing into ${describeUrl(url)}${args.dryRun ? ' (dry run: nothing will be saved)' : ''}`);
    const r = await importRows(pool, legacy, { source, dryRun: args.dryRun });
    console.log(`Projects:         ${r.projects.added} added, ${r.projects.skipped} already imported`);
    console.log(`Tasks:            ${r.tasks.added} added, ${r.tasks.skipped} already imported`);
    console.log(`Task comments:    ${r.comments.added} added, ${r.comments.skipped} already imported`);
    console.log(`Project comments: ${r.projectComments.added} added, ${r.projectComments.skipped} already imported`);
    for (const w of r.warnings) console.warn(`Note: ${w}`);
    console.log(args.dryRun ? 'Dry run finished: nothing was saved.' : 'Import finished.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Import failed, nothing was saved: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { importRows, readSqlite, readMysql, legacyMoment, legacyDate, parseArgs };
