'use strict';

/* The agent-facing files in `.claude/skills/` are instructions to future
   sessions, and nothing else in CI reads a word of them. Two failure modes are
   both silent and both expensive:

   - A skill whose frontmatter `name` no longer matches its directory, or whose
     `description` is empty, simply never triggers. There is no error — the skill
     is just quietly unreachable, and you find out by wondering why nothing
     happened.
   - A skill that cites `.claude/rules/<x>.md` or `test/<x>.js` after that file was
     renamed sends the next session looking for something that isn't there. Rules
     and skills cross-reference each other heavily, so one rename strands several
     pointers at once.

   Both are mechanical, so they are checked here rather than left to the
   `claude-file-audit` skill (criteria C-001/C-003/C-007) — a check that runs in CI
   forever beats one that runs when someone remembers to audit. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKILLS = path.join(ROOT, '.claude', 'skills');

const dirs = fs.readdirSync(SKILLS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

// Every markdown file under .claude/skills/, as [repo-relative path, text].
const docs = dirs.flatMap((d) => fs.readdirSync(path.join(SKILLS, d))
  .filter((f) => f.endsWith('.md'))
  .map((f) => [`.claude/skills/${d}/${f}`, fs.readFileSync(path.join(SKILLS, d, f), 'utf8')]));

// The YAML-ish frontmatter block, or null when the file opens without one.
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  return m ? m[1] : null;
};

// A scalar frontmatter field, supporting YAML's `>-` folded-block form.
const field = (fm, key) => {
  const m = new RegExp(`^${key}:\\s*(>-|\\|-?)?[ \\t]*(.*(?:\\n(?:[ \\t]+.*|))*)`, 'm').exec(fm);
  return m ? m[2].replace(/\s+/g, ' ').trim() : null;
};

test('every skill directory holds a SKILL.md', () => {
  assert.ok(dirs.length > 0, 'no skills found');
  for (const d of dirs) {
    assert.ok(fs.existsSync(path.join(SKILLS, d, 'SKILL.md')), `.claude/skills/${d}/SKILL.md is missing`);
  }
});

test('each SKILL.md declares a name matching its directory and a real description', () => {
  for (const d of dirs) {
    const fm = frontmatter(fs.readFileSync(path.join(SKILLS, d, 'SKILL.md'), 'utf8'));
    assert.ok(fm, `${d}: SKILL.md has no frontmatter block`);

    assert.equal(field(fm, 'name'), d, `${d}: frontmatter name must equal the directory name`);

    // The description is the whole triggering mechanism: it must say what the
    // skill does AND when to reach for it, so a bare label is a defect.
    const desc = field(fm, 'description') || '';
    assert.ok(desc.length >= 40, `${d}: description is too thin to trigger on ("${desc}")`);
    assert.match(desc, /\bUse (when(ever)?|for|to)\b/i, `${d}: description must say when to use the skill`);
  }
});

test('every repo path a skill cites actually exists', () => {
  // Deliberately narrow: the three families that get renamed and stranded in
  // practice. Paths under data/ and dist/ are excluded — neither is committed,
  // so asserting on them would fail in CI while the reference is perfectly fine.
  const PATH_RE = /(?:\.claude\/(?:rules|skills)\/[A-Za-z0-9_./-]+\.md|test\/[A-Za-z0-9_./-]+\.js|docs\/[A-Za-z0-9_./-]+\.md)/g;

  const missing = [];
  for (const [file, text] of docs) {
    for (const ref of new Set(text.match(PATH_RE) || [])) {
      if (!fs.existsSync(path.join(ROOT, ref))) missing.push(`${file} -> ${ref}`);
    }
  }
  assert.deepEqual(missing, [], `dangling references:\n  ${missing.join('\n  ')}`);
});

test('every audit skill carries a criteria file the loop can read', () => {
  // The loop in .claude/skills/audit/audit-loop.md gates its research phase on
  // these two header fields. A malformed header does not throw — research would
  // just silently never run (or run every time), so pin the shape.
  const audits = dirs.filter((d) => d.endsWith('-audit'));
  assert.ok(audits.length >= 3, 'expected the accessibility, legal and claude-file audits');

  for (const d of audits) {
    const p = path.join(SKILLS, d, 'criteria.md');
    assert.ok(fs.existsSync(p), `${d}: criteria.md is missing`);

    const text = fs.readFileSync(p, 'utf8');
    assert.match(text, /^- \*\*last-researched:\*\* (never|\d{4}-\d{2}-\d{2})$/m,
      `${d}: criteria.md needs a last-researched date (or "never")`);
    assert.match(text, /^- \*\*cadence:\*\* \d+ days$/m,
      `${d}: criteria.md needs a research cadence in days`);

    // Rejected entries are the ledger that stops a rejected criterion being
    // re-litigated every run — losing the section quietly loses that memory.
    assert.match(text, /^## Rejected/m, `${d}: criteria.md must keep its Rejected section`);
  }

  // The shared loop the three domain skills all delegate to.
  assert.ok(fs.existsSync(path.join(SKILLS, 'audit', 'audit-loop.md')),
    '.claude/skills/audit/audit-loop.md is missing');
});
