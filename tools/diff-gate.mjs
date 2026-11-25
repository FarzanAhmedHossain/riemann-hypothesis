#!/usr/bin/env node
// Deterministic content gate for a ready record, run BEFORE its fix is built (pr120-attack build-after):
//   node tools/diff-gate.mjs <repo dir> <record.json>
// The repo must have the record's base and head commits. Exit 0 when the change from base to head touches exactly
// the record's files, only regular src/**/*.lean files outside the protected ones, and adds nothing forbidden
// (tools/gate-rules.mjs). Otherwise print the reason and exit 1.
import fs from 'node:fs';
import { checkDiff } from './gate-rules.mjs';

const [repo, recFile] = process.argv.slice(2);
const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
if (!/^[0-9a-f]{40}$/.test(rec.base || '') || !/^[0-9a-f]{40}$/.test(rec.head || '') || !Array.isArray(rec.files)) { console.error('bad record'); process.exit(1); }
const { error } = checkDiff(repo, rec.base, rec.head, rec.files);
if (error) { console.error(error); process.exit(1); }
console.log(`gate passed: ${rec.files.length} file(s)`);
