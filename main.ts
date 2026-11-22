// mend: one command-line tool that applies AI-written edits in four formats
// (unified diff, SEARCH/REPLACE blocks, V4A patches, JSON tool calls) to a tree
// of text files, to SPEC.md version 1. Node 22, standard library alone.
// Run as `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and
// then this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: exactly one line on stdout, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One failed edit: its code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

/** A move an edit made, for the `R old -> new` output line. */
interface Move {
  old: string;
  nw: string;
}

const blank = (s: string): boolean => s.trim() === '';

/** Byte order of two paths, for the sorted output lines. */
function cmpBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** The leading spaces and tabs of a line. */
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A line with its trailing spaces and tabs removed. */
function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

/** A line with its leading and trailing spaces and tabs removed. */
function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and no
 * empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`,
 * and none of its `/`-separated segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break, its lines without terminators, and
 * whether it ends with a line break. An empty file has no lines. */
interface FileState {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const parts = text.split(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  state(p: string): FileState | null {
    const t = this.get(p);
    return t === null ? null : splitFile(t);
  }
  setText(p: string, text: string): void {
    this.now.set(p, text);
  }
  setState(p: string, f: FileState): void {
    this.now.set(p, joinFile(f));
  }
}

/** Two lines equal at one matching tier: 0 exactly, 1 after trailing spaces
 * and tabs are removed from both, 2 after leading and trailing spaces and
 * tabs are removed from both. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where O occurs in `lines` at one tier; occurrences
 * may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions; with
 * `--strict` only tier 0 is tried. */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** The first tier at which O occurs at or after `from`, with those positions. */
function findTierFrom(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, o, t).filter((p) => p >= from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of the replacement text: a context line carries the index of the
 * old line it mirrors, any other line carries null. */
interface NewLine {
  text: string;
  oIdx: number | null;
}

/** Split hunk or chunk body items into old lines O and new lines N. A context
 * line is in both; a `-` line only in O; a `+` line only in N. */
interface BodyItem {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

function splitBody(items: BodyItem[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of items) {
    if (it.kind === ' ') {
      n.push({ text: it.text, oIdx: o.length });
      o.push(it.text);
    } else if (it.kind === '-') {
      o.push(it.text);
    } else if (it.kind === '+') {
      n.push({ text: it.text, oIdx: null });
    }
  }
  return { o, n };
}

/** The replacement lines for an occurrence of O at position `at` in `lines`.
 * A context line is written as the file's own matched line, never the patch's.
 * At tier 2 every other line is re-indented: F is the leading whitespace of
 * the file's first matched line, P that of O's first line, and a line of N
 * that is not empty, not only whitespace, and starts with P has that P
 * replaced by F. At tiers 0 and 1 the lines of N are written as they are. */
function applyAt(lines: string[], at: number, o: string[], n: NewLine[], tier: number): string[] {
  const f = o.length > 0 && at < lines.length ? leadWs(lines[at]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  return n.map((nl) => {
    if (nl.oIdx !== null) return lines[at + nl.oIdx]!;
    let t = nl.text;
    if (o.length > 0 && tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    return t;
  });
}

/** Detect the patch format (section 4): the first of these that holds, where
 * a blank line is empty or only whitespace. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** The command line (section 1): options and PATCH in any order, `--` ends
 * the options. A usage error is an argument starting with `-` that is not
 * `-` and not one of the options above (before `--`), an option given twice,
 * a `--format` value other than the five names, or more than one positional. */
interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(args: string[]): Options {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else throw new Exit2('error: usage');
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) throw new Exit2('error: usage');
  return { format: format ?? 'auto', check, strict, patch: pos.length === 0 || pos[0] === '-' ? null : pos[0]! };
}

/** One edit: it changes the tree or throws Fail. It returns a move when it
 * moved a file, else null. */
type Edit = (tree: Tree) => Move | null;

/** One JSON edit object (section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.setText(p, text);
      return null;
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      tree.setText(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      return null;
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = need(tree);
      const file = splitFile(before);
      if (line < 0 || line > file.lines.length) throw new Fail('no-match', p);
      file.lines.splice(line, 0, ...add);
      tree.setState(p, file);
      return null;
    };
  }
  return null;
}

/** The JSON edits of a patch (section 9): one JSON array of edit objects, or
 * JSON Lines with one edit object a line and blank lines ignored. In array
 * form any fault is `error: parse <the line where the array starts>`; in JSON
 * Lines form a line that does not hold one valid edit object is
 * `error: parse <that line>`. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One hunk: its old start line A and its body items. */
interface Hunk {
  a: number;
  items: BodyItem[];
}

/** One unified section, with the paths its header named. */
interface Section {
  pairOld: string | null;
  pairNew: string | null;
  renOld: string | null;
  renNew: string | null;
  diffOld: string | null;
  diffNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: the text after the four
 * characters, up to the first tab, with surrounding spaces removed, and a
 * leading `a/` or `b/` removed. */
function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** A `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function diffPaths(line: string): [string, string] | null {
  const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
  return m === null ? null : [m[1]!, m[2]!];
}

/** A hunk header `@@ -A[,B] +C[,D] @@`, optionally followed by text, or null
 * when the line does not start a hunk. B and D are not used. */
function hunkStart(line: string): number | null {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  return m === null ? null : Number(m[1]);
}

/** Read a hunk body starting after the header at line `h`: the lines that
 * start with ` `, `-`, `+` or `\`, or are empty (an empty line is a context
 * line whose text is empty). The body ends at the first other line, at a
 * `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at the
 * end of the patch; empty lines at the end of a body are not part of it.
 * Returns the index of the line where the body ended. */
function readHunk(lines: string[], h: number, a: number, sec: Section): number {
  const items: BodyItem[] = [];
  let j = h + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: ' ', text: '' });
      j++;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      items.push({ kind: c, text: l.slice(1) });
      j++;
      continue;
    }
    break;
  }
  while (items.length > 0) {
    const last = items[items.length - 1]!;
    if (last.kind === ' ' && last.text === '') items.pop();
    else break;
  }
  sec.hunks.push({ a, items });
  return j;
}

/** Parse a unified diff patch into its sections (section 6). */
function unifiedSections(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let pairSeen = false;
  let state: 'outside' | 'header' | 'between' = 'outside';
  const startSection = (diffOld: string | null, diffNew: string | null): void => {
    if (cur !== null) sections.push(cur);
    cur = { pairOld: null, pairNew: null, renOld: null, renNew: null, diffOld, diffNew, create: false, del: false, hunks: [] };
    pairSeen = false;
    state = 'header';
  };
  const takePair = (i: number): void => {
    cur!.pairOld = headerPath(lines[i]!);
    cur!.pairNew = headerPath(lines[i + 1]!);
    pairSeen = true;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (state === 'outside') {
      if (l.startsWith('diff --git ')) {
        const d = diffPaths(l);
        if (d === null) throw new Exit2(`error: parse ${i + 1}`);
        startSection(d[0], d[1]);
        i++;
      } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        startSection(null, null);
        takePair(i);
        i += 2;
      } else if (l.startsWith('@@')) {
        throw new Exit2(`error: parse ${i + 1}`);
      } else {
        i++;
      }
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const d = diffPaths(l);
      if (d === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(d[0], d[1]);
      i++;
      continue;
    }
    if (state === 'header' && l.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (pairSeen) startSection(null, null);
        takePair(i);
        i += 2;
      } else {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      continue;
    }
    if (state === 'between' && l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      startSection(null, null);
      takePair(i);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const a = hunkStart(l);
      if (a === null) throw new Exit2(`error: parse ${i + 1}`);
      i = readHunk(lines, i, a, cur!);
      state = 'between';
      continue;
    }
    if (state === 'header') {
      if (l.startsWith('rename from ')) {
        if (cur!.renOld === null) cur!.renOld = l.slice(12).trim();
      } else if (l.startsWith('rename to ')) {
        if (cur!.renNew === null) cur!.renNew = l.slice(10).trim();
      } else if (l.startsWith('new file mode')) {
        cur!.create = true;
      } else if (l.startsWith('deleted file mode')) {
        cur!.del = true;
      }
      i++;
      continue;
    }
    i++;
  }
  if (cur !== null) sections.push(cur);
  return sections;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function hunkNoBreak(h: Hunk): boolean {
  for (let k = h.items.length - 1; k >= 0; k--) {
    const it = h.items[k]!;
    if (it.kind === ' ' || it.kind === '+') {
      return k + 1 < h.items.length && h.items[k + 1]!.kind === '\\';
    }
  }
  return false;
}

/** Apply a section's hunks in order, each to the result of the ones before
 * it. O is the hunk's context and `-` lines, N its context and `+` lines.
 * d is the sum over this section's hunks applied so far of (N's length minus
 * O's length). When O is not empty, of the occurrences at the tier where O is
 * found, the hunk takes the one whose 0-based position is nearest to A - 1 +
 * d; of two equally near, the earlier. When O is empty, N is inserted after
 * the first A + d lines (all of them when the file has fewer). */
function applyHunks(file: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  const cur: FileState = { br: file.br, lines: [...file.lines], final: file.final };
  let d = 0;
  for (const h of hunks) {
    const { o, n } = splitBody(h.items);
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > cur.lines.length) pos = cur.lines.length;
      const atEnd = pos === cur.lines.length;
      const ins = applyAt(cur.lines, pos, o, n, -1);
      cur.lines.splice(pos, 0, ...ins);
      if (atEnd) cur.final = !hunkNoBreak(h);
      d += n.length - o.length;
      continue;
    }
    const found = findTier(cur.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dd = Math.abs(p - target);
      if (dd < bestDist) {
        best = p;
        bestDist = dd;
      }
    }
    const rep = applyAt(cur.lines, best, o, n, found.tier);
    const runsToEnd = best + o.length === cur.lines.length;
    cur.lines.splice(best, o.length, ...rep);
    if (runsToEnd) cur.final = !hunkNoBreak(h);
    d += n.length - o.length;
  }
  return cur;
}

/** Whether a `\` line follows the last `+` line of a creation's hunks. */
function creationNoBreak(hunks: Hunk[]): boolean {
  let lastH: Hunk | null = null;
  let lastK = -1;
  for (const h of hunks) {
    for (let k = 0; k < h.items.length; k++) {
      if (h.items[k]!.kind === '+') {
        lastH = h;
        lastK = k;
      }
    }
  }
  if (lastH === null) return false;
  return lastK + 1 < lastH.items.length && lastH.items[lastK + 1]!.kind === '\\';
}

/** One unified section as one edit. The paths come from the `---`/`+++` pair
 * when it names them, else from `rename from`/`rename to`, else from the
 * `diff --git` line; `/dev/null` means no file. */
function sectionEdit(s: Section, strict: boolean): Edit {
  const oldRaw = s.pairOld ?? s.renOld ?? s.diffOld;
  const newRaw = s.pairNew ?? s.renNew ?? s.diffNew;
  const oldP = oldRaw === null || oldRaw === '/dev/null' ? null : oldRaw;
  const newP = newRaw === null || newRaw === '/dev/null' ? null : newRaw;
  return (tree) => {
    if ((s.create || oldP === null) && newP !== null) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const ls: string[] = [];
      for (const h of s.hunks) {
        for (const it of h.items) {
          if (it.kind === '+') ls.push(it.text);
        }
      }
      const file: FileState = { br: '\n', lines: ls, final: ls.length > 0 && !creationNoBreak(s.hunks) };
      tree.setState(newP, file);
      return null;
    }
    if ((s.del || newP === null) && oldP !== null) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return null;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.state(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyHunks(before, s.hunks, strict, oldP);
      tree.setState(newP, after);
      tree.now.set(oldP, null);
      return { old: oldP, nw: newP };
    }
    if (oldP !== null) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      const before = tree.state(oldP);
      if (before === null) throw new Fail('missing', oldP);
      tree.setState(oldP, applyHunks(before, s.hunks, strict, oldP));
      return null;
    }
    return null;
  };
}

/** The unified diff edits of a patch: one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return unifiedSections(lines).map((s) => sectionEdit(s, strict));
}

/** One SEARCH/REPLACE block as one edit. With empty old lines the file is
 * created with the new lines; otherwise the file exists, the old lines occur
 * at their tier exactly once, and the new lines replace them. */
function srEdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const file: FileState = { br: '\n', lines: [...nw], final: nw.length > 0 };
      tree.setState(path, file);
      return null;
    }
    const before = tree.state(path);
    if (before === null) throw new Fail('missing', path);
    const found = findTier(before.lines, old, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const rep = applyAt(before.lines, found.pos[0]!, old, nw.map((t) => ({ text: t, oIdx: null })), found.tier);
    before.lines.splice(found.pos[0]!, old.length, ...rep);
    tree.setState(path, before);
    return null;
  };
}

/** The SEARCH/REPLACE edits of a patch (section 7). The path is the nearest
 * line before the `<<<<<<< SEARCH` line, and after the previous block's
 * `>>>>>>> REPLACE` line (or the start of the patch), that is not blank and,
 * its surrounding whitespace removed, does not start with three backticks;
 * the path is that line with its surrounding whitespace removed. When there
 * is no such line the block takes the previous block's path; the first block
 * with none is `error: parse <its SEARCH line>`. */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (eq === -1 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq !== -1 && t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq === -1 || rep === -1) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(srEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: its anchor (null: none), whether `*** End of File` anchors
 * it to the end of the file, and its body items. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

/** One V4A section. */
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  chunks: VChunk[];
  addLines: string[];
}

/** Parse one V4A section's body lines (already without trailing blank
 * lines). `headIdx` is the 0-based line of its `*** ... File:` line. */
function parseVSection(kind: 'add' | 'delete' | 'update', path: string, body: string[], bodyIdx: number[], headIdx: number): VSection {
  if (kind === 'add') {
    for (let k = 0; k < body.length; k++) {
      const l = body[k]!;
      if (l === '' || l.startsWith('+')) continue;
      throw new Exit2(`error: parse ${bodyIdx[k]! + 1}`);
    }
    return { kind, path, moveTo: null, chunks: [], addLines: body.map((l) => (l === '' ? '' : l.slice(1))) };
  }
  if (kind === 'delete') {
    if (body.length > 0) throw new Exit2(`error: parse ${bodyIdx[0]! + 1}`);
    return { kind, path, moveTo: null, chunks: [], addLines: [] };
  }
  let moveTo: string | null = null;
  let start = 0;
  if (body.length > 0 && body[0]!.startsWith('*** Move to:')) {
    moveTo = body[0]!.slice(12).trim();
    start = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = start; k < body.length; k++) {
    const l = body[k]!;
    const ln = bodyIdx[k]! + 1;
    if (l.startsWith('@@')) {
      const a = l.slice(2).trim();
      cur = { anchor: a === '' ? null : a, eof: false, items: [] };
      chunks.push(cur);
    } else if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${ln}`);
      cur.eof = true;
      cur = null;
    } else if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
        cur = { anchor: null, eof: false, items: [] };
        chunks.push(cur);
      }
      cur.items.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
    } else {
      throw new Exit2(`error: parse ${ln}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headIdx + 1}`);
  return { kind, path, moveTo, chunks, addLines: [] };
}

/** Apply an Update File section's chunks in order, with a cursor that starts
 * at line 0. A chunk with an anchor first finds the first line at or after
 * the cursor equal to the anchor at the first tier where one is (both sides a
 * single line), else `no-match`; the cursor moves past it. The chunk takes
 * the first occurrence of O at or after the cursor, at the first tier with
 * one; an end-of-file chunk takes only an occurrence that ends at the file's
 * last line. When O is empty, N is inserted at the cursor, or at the end of
 * the file for an end-of-file chunk. The cursor then moves to just after the
 * lines written. */
function applyV4aChunks(file: FileState, chunks: VChunk[], strict: boolean, path: string): FileState {
  const cur: FileState = { br: file.br, lines: [...file.lines], final: file.final };
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const found = findTierFrom(cur.lines, [c.anchor], cursor, strict);
      if (found === null) throw new Fail('no-match', path);
      cursor = found.pos[0]! + 1;
    }
    const { o, n } = splitBody(c.items);
    if (o.length === 0) {
      const pos = c.eof ? cur.lines.length : cursor;
      const ins = applyAt(cur.lines, pos, o, n, -1);
      cur.lines.splice(pos, 0, ...ins);
      cursor = pos + ins.length;
      continue;
    }
    const found = findTierFrom(cur.lines, o, cursor, strict);
    if (found === null) throw new Fail('no-match', path);
    let at: number;
    if (c.eof) {
      const want = cur.lines.length - o.length;
      if (want < cursor || !found.pos.includes(want)) throw new Fail('no-match', path);
      at = want;
    } else {
      at = found.pos[0]!;
    }
    const rep = applyAt(cur.lines, at, o, n, found.tier);
    cur.lines.splice(at, o.length, ...rep);
    cursor = at + rep.length;
  }
  return cur;
}

/** One V4A section as one edit. */
function vSectionEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const file: FileState = { br: '\n', lines: [...s.addLines], final: s.addLines.length > 0 };
      tree.setState(s.path, file);
      return null;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return null;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.state(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const after = applyV4aChunks(before, s.chunks, strict, s.path);
    if (s.moveTo !== null) {
      tree.setState(s.moveTo, after);
      tree.now.set(s.path, null);
      return { old: s.path, nw: s.moveTo };
    }
    tree.setState(s.path, after);
    return null;
  };
}

/** The V4A edits of a patch (section 8). The first non-blank line is
 * `*** Begin Patch` and the last non-blank line is `*** End Patch`, both
 * compared with their surrounding whitespace removed. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isHead = (l: string): boolean => l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:');
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (l.startsWith('*** Add File:')) {
      kind = 'add';
      path = l.slice(13).trim();
    } else if (l.startsWith('*** Delete File:')) {
      kind = 'delete';
      path = l.slice(16).trim();
    } else if (l.startsWith('*** Update File:')) {
      kind = 'update';
      path = l.slice(16).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const body: string[] = [];
    const bodyIdx: number[] = [];
    let j = i + 1;
    while (j < last && !isHead(lines[j]!)) {
      body.push(lines[j]!);
      bodyIdx.push(j);
      j++;
    }
    while (body.length > 0 && blank(body[body.length - 1]!)) {
      body.pop();
      bodyIdx.pop();
    }
    edits.push(vSectionEdit(parseVSection(kind, path, body, bodyIdx, i), strict));
    i = j;
  }
  return edits;
}

/** Run the CLI (sections 1, 2 and 10). A usage error wins over everything,
 * and a parse error is reported before any file is looked at. Edits apply in
 * the patch's order to the tree as earlier edits left it; a failed edit
 * changes nothing, and the edits after it still run, so every failure is
 * reported. When any edit failed, no file is written (exit 1). When none
 * failed, every change is written (exit 0), or with `--check` none is. */
function run(args: string[]): { code: number; out: string[] } {
  let opts: Options;
  try {
    opts = parseArgs(args);
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  let text = '';
  try {
    text = readFileSync(opts.patch ?? 0, 'utf8');
  } catch {
    if (opts.patch !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = opts.format === 'auto' ? detect(lines) : opts.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, opts.strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, opts.strict);
    else edits = v4aEdits(lines, opts.strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: Move[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      const m = edit(tree);
      if (m !== null) moves.push(m);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  for (const m of moves) {
    if (tree.original(m.old) !== null && tree.get(m.old) === null && tree.original(m.nw) === null && tree.get(m.nw) !== null) {
      rows.push({ key: m.nw, text: `R ${m.old} -> ${m.nw}` });
      suppressed.add(m.old);
      suppressed.add(m.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort(cmpBytes)) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => cmpBytes(a.key, b.key));
  if (!opts.check) {
    for (const p of [...tree.now.keys()].sort(cmpBytes)) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
