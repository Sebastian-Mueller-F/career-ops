#!/usr/bin/env node
/**
 * auto-reject-stale.mjs — moves "Applied" rows with no reply to "Rejected"
 * after a set number of days (default 30).
 *
 * A row counts as unanswered while its status is still exactly "Applied".
 * Any reply (Responded, Interview, …) changes the status first, so those rows
 * are never touched.
 *
 * Applied date, most reliable source first:
 *   1. latest "→ Applied" entry for the row in data/status-log.tsv
 *   2. "Applied YYYY-MM-DD" in the Notes cell
 *   3. the row's Date column (evaluation date — the earliest possible send date)
 *
 * Writes go through set-status.mjs (locked, validated, logged), never directly.
 *
 * With --apply it also tidies the draft folders: every file in
 * output/{draft-cv,draft-cover,draft-mails,mails}/ whose name starts with a
 * report number (`014-…`, or `038-039-…` for a shared draft) moves into that
 * folder's archive/ subfolder once ALL of its numbers belong to closed rows
 * (Rejected or Discarded). Files are moved, never deleted, and never
 * overwritten. Generated CV/cover PDFs in output/ itself carry no number and
 * stay a manual step.
 *
 * Usage:
 *   node auto-reject-stale.mjs                 # dry run: list what would move
 *   node auto-reject-stale.mjs --apply         # move them
 *   node auto-reject-stale.mjs --days 21       # different threshold
 *   node auto-reject-stale.mjs --json
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { getCareerOpsRoot, resolveTrackerPath } from './path-resolver.mjs';
import { resolveColumns, parseTrackerRow, extractTrackerReportNumbers } from './tracker-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = 86_400_000;
const CLOSED = new Set(['Rejected', 'Discarded']);
const DRAFT_DIRS = ['draft-cv', 'draft-cover', 'draft-mails', 'mails'];
const PREFIX_RE = /^(\d{3}(?:-\d{3})*)-/;

function parseArgs(argv) {
  const opts = { apply: false, days: 30, json: false, today: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--days') opts.days = Number(argv[++i]);
    else if (a === '--today') opts.today = argv[++i];
    else { console.error(`Unknown flag: ${a}`); process.exit(2); }
  }
  if (!Number.isFinite(opts.days) || opts.days < 1) {
    console.error('--days must be a positive number'); process.exit(2);
  }
  return opts;
}

function appliedDatesFromLog(logPath) {
  const map = new Map();
  if (!existsSync(logPath)) return map;
  for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
    const [num, date, , to] = line.split('\t');
    if (to?.trim() === 'Applied' && /^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      const prev = map.get(num);
      if (!prev || date > prev) map.set(num, date);
    }
  }
  return map;
}

export function findStale({ trackerPath, logPath, days, today }) {
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  const logDates = appliedDatesFromLog(logPath);
  const now = today ? new Date(`${today}T00:00:00Z`) : new Date();
  const stale = [];
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row || row.status !== 'Applied') continue;
    const noteDate = (row.notes || '').match(/Applied (\d{4}-\d{2}-\d{2})/)?.[1];
    const appliedOn = logDates.get(String(row.num)) || noteDate || row.date;
    const source = logDates.has(String(row.num)) ? 'status-log' : noteDate ? 'notes' : 'row-date';
    const age = Math.floor((now - new Date(`${appliedOn}T00:00:00Z`)) / DAY);
    if (Number.isFinite(age) && age >= days) {
      stale.push({ num: row.num, company: row.company, role: row.role, appliedOn, source, days: age });
    }
  }
  return stale;
}

// Report numbers of closed rows and of open rows. A number on both sides
// (two rows sharing a report) counts as open, so nothing still live moves.
export function closedReportNumbers(trackerPath) {
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  const colmap = resolveColumns(lines);
  const closed = new Set();
  const open = new Set();
  for (const line of lines) {
    const row = parseTrackerRow(line, colmap);
    if (!row) continue;
    const nums = extractTrackerReportNumbers(row.report, row.notes);
    const list = nums.length ? nums : [row.num];
    for (const n of list) (CLOSED.has(row.status) ? closed : open).add(Number(n));
  }
  for (const n of open) closed.delete(n);
  return closed;
}

export function archiveDrafts(outputDir, closed, { apply }) {
  const moved = [];
  for (const dir of DRAFT_DIRS) {
    const abs = join(outputDir, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs, { withFileTypes: true })) {
      if (!name.isFile()) continue;
      const m = name.name.match(PREFIX_RE);
      if (!m) continue;
      const nums = m[1].split('-').map(Number);
      if (!nums.every(n => closed.has(n))) continue;
      const dest = join(abs, 'archive', name.name);
      if (existsSync(dest)) { moved.push({ file: `${dir}/${name.name}`, action: 'skipped-exists' }); continue; }
      if (apply) {
        mkdirSync(join(abs, 'archive'), { recursive: true });
        renameSync(join(abs, name.name), dest);
      }
      moved.push({ file: `${dir}/${name.name}`, action: apply ? 'archived' : 'would-archive' });
    }
  }
  return moved;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const root = getCareerOpsRoot();
  const trackerPath = resolveTrackerPath(root);
  if (!existsSync(trackerPath)) { console.error(`No tracker at ${trackerPath}`); process.exit(1); }
  const logPath = join(dirname(trackerPath), 'status-log.tsv');
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const stale = findStale({ trackerPath, logPath, days: opts.days, today });

  const results = [];
  for (const s of stale) {
    if (!opts.apply) { results.push({ ...s, action: 'would-reject' }); continue; }
    const note = `Keine Antwort ${s.days} Tage nach Bewerbung (${s.appliedOn}), automatisch auf Rejected gesetzt ${today}`;
    try {
      execFileSync(process.execPath, [join(HERE, 'set-status.mjs'), '--row', String(s.num), 'Rejected', '--note', note],
        { env: { ...process.env, CAREER_OPS_TRACKER: trackerPath }, stdio: 'pipe' });
      results.push({ ...s, action: 'rejected' });
    } catch (err) {
      results.push({ ...s, action: 'error', error: String(err.stderr || err.message).trim() });
    }
  }

  const outputDir = join(dirname(dirname(trackerPath)), 'output');
  const archived = archiveDrafts(outputDir, closedReportNumbers(trackerPath), { apply: opts.apply });

  if (opts.json) {
    console.log(JSON.stringify({ tracker: trackerPath, days: opts.days, apply: opts.apply, results, archived }, null, 2));
    process.exit(results.some(r => r.action === 'error') ? 1 : 0);
  }
  if (!results.length) {
    console.log(`Keine Bewerbung ist seit ${opts.days}+ Tagen ohne Antwort auf "Applied".`);
  } else {
    const verb = { 'would-reject': 'würde → Rejected', rejected: '→ Rejected', error: 'FEHLER' };
    for (const r of results) {
      console.log(`#${r.num} ${r.company} — ${r.role} | beworben ${r.appliedOn} (${r.source}), ${r.days} Tage | ${verb[r.action]}${r.error ? `: ${r.error}` : ''}`);
    }
  }
  if (archived.length) {
    const label = { archived: 'archiviert', 'would-archive': 'würde archivieren', 'skipped-exists': 'übersprungen, liegt schon im Archiv' };
    console.log(`\nEntwürfe und Mails abgeschlossener Bewerbungen (→ archive/):`);
    for (const a of archived) console.log(`  ${a.file} | ${label[a.action]}`);
  }
  if (!opts.apply && (results.length || archived.length)) console.log('\nTrockenlauf. Mit --apply ausführen.');
  process.exit(results.some(r => r.action === 'error') ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
