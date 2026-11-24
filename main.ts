// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
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
}

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

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

// ---- Sections 5 to 8: tier matching, unified diffs, SEARCH/REPLACE blocks, V4A patches. ----

interface FileLines {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(f: FileLines): string {
  return f.lines.length === 0 ? '' : f.lines.join(f.br) + (f.final ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => stripTrail(s.replace(/^[ \t]+/, ''));
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

interface Occ {
  tier: number;
  positions: number[];
}

/** Occurrences of O in fileLines at the first tier that has one, at or after `from`. */
function findOcc(fileLines: string[], o: string[], strict: boolean, from = 0, mustEnd = false): Occ | null {
  if (o.length === 0) return null;
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = Math.max(0, from); i + o.length <= fileLines.length; i += 1) {
      if (mustEnd && i + o.length !== fileLines.length) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (normLine(fileLines[i + j]!, tier) !== normLine(o[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

type SeqKind = 'ctx' | 'old' | 'new';
interface SeqLine {
  kind: SeqKind;
  text: string;
  noNl: boolean;
  fromEmpty: boolean;
}
const seqLine = (kind: SeqKind, text: string, fromEmpty = false): SeqLine => ({ kind, text, noNl: false, fromEmpty });

/** The lines N writes for a match of O at `pos`: context lines are the file's own, tier 2 re-indents the rest. */
function buildNew(seq: SeqLine[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  const out: string[] = [];
  const f = o.length > 0 ? leadWs(fileLines[pos]!) : '';
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  let oi = 0;
  for (const el of seq) {
    if (el.kind === 'ctx') {
      out.push(fileLines[pos + oi]!);
      oi += 1;
    } else if (el.kind === 'old') {
      oi += 1;
    } else {
      let t = el.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
      out.push(t);
    }
  }
  return out;
}

function lastWrittenNoNl(seq: SeqLine[]): boolean {
  for (let i = seq.length - 1; i >= 0; i -= 1) {
    if (seq[i]!.kind !== 'old') return seq[i]!.noNl;
  }
  return false;
}

// ---- Section 6: unified diffs ----

interface UHunk {
  a: number;
  seq: SeqLine[];
}
interface USection {
  diffOld: string | undefined;
  diffNew: string | undefined;
  minus: string | null | undefined;
  plus: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: UHunk[];
}

function headerPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  const newSection = (): USection => {
    const s: USection = { diffOld: undefined, diffNew: undefined, minus: undefined, plus: undefined, renameFrom: undefined, renameTo: undefined, newFile: false, deletedFile: false, hunks: [] };
    sections.push(s);
    cur = s;
    return s;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        const s = cur !== null && cur.hunks.length === 0 && cur.minus === undefined ? cur : newSection();
        s.minus = headerPath(line.slice(4));
        s.plus = headerPath(next.slice(4));
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(?:\s.*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const seq: SeqLine[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith(' ')) seq.push(seqLine('ctx', l.slice(1)));
        else if (l.startsWith('-')) seq.push(seqLine('old', l.slice(1)));
        else if (l.startsWith('+')) seq.push(seqLine('new', l.slice(1)));
        else if (l.startsWith('\\')) {
          const prev = seq[seq.length - 1];
          if (prev !== undefined) prev.noNl = true;
        } else if (l === '') seq.push(seqLine('ctx', '', true));
        else break;
        j += 1;
      }
      while (seq.length > 0 && seq[seq.length - 1]!.fromEmpty) seq.pop();
      cur.hunks.push({ a: Number(m[1]), seq });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

function applyUHunks(f: FileLines, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o = h.seq.filter((e) => e.kind !== 'new').map((e) => e.text);
    const nLen = h.seq.filter((e) => e.kind !== 'old').length;
    if (o.length === 0) {
      const add = buildNew(h.seq, f.lines, 0, 0, o);
      const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...add);
      if (atEnd && add.length > 0) f.final = !lastWrittenNoNl(h.seq);
      d += add.length;
      continue;
    }
    const occ = findOcc(f.lines, o, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let pos = occ.positions[0]!;
    for (const p of occ.positions) {
      if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
    }
    const add = buildNew(h.seq, f.lines, pos, occ.tier, o);
    const toEnd = pos + o.length === f.lines.length;
    f.lines.splice(pos, o.length, ...add);
    if (toEnd) f.final = !lastWrittenNoNl(h.seq);
    d += nLen - o.length;
  }
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.minus !== undefined ? s.minus : s.renameFrom !== undefined ? s.renameFrom : s.diffOld;
  const newPath = s.plus !== undefined ? s.plus : s.renameTo !== undefined ? s.renameTo : s.diffNew;
  const creation = oldPath === null || s.newFile;
  const deletion = newPath === null || s.deletedFile;
  return (tree) => {
    if (creation) {
      const p = newPath ?? oldPath;
      if (p === null || p === undefined) throw new Fail('missing', '');
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let noNl = false;
      for (const h of s.hunks) {
        for (const e of h.seq) {
          if (e.kind === 'new') {
            out.push(e.text);
            noNl = e.noNl;
          }
        }
      }
      tree.now.set(p, out.length === 0 ? '' : out.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    const op = oldPath ?? newPath;
    if (op === null || op === undefined) throw new Fail('missing', '');
    if (!safe(op)) throw new Fail('unsafe', op);
    if (deletion) {
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const np = newPath ?? oldPath;
    if (np === null || np === undefined) throw new Fail('missing', op);
    const isMove = np !== op;
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const f = splitFile(before);
    applyUHunks(f, s.hunks, strict, op);
    const text = joinFile(f);
    if (isMove) {
      tree.now.set(op, null);
      tree.now.set(np, text);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, text);
    }
  };
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let scanFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i + 1;
    let eq = -1;
    let rep = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      const t = lines[j]!.trimEnd();
      if (eq < 0 && t === '=======') eq = j;
      else if (eq >= 0 && t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      } else if (eq < 0 && t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let path: string | null = null;
    for (let j = i - 1; j >= scanFrom; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine}`);
    prevPath = path;
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    scanFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

function srEdit(p: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (oldLines.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const occ = findOcc(f.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', p);
    if (occ.positions.length > 1) throw new Fail('ambiguous', p);
    const pos = occ.positions[0]!;
    const add = buildNew(newLines.map((t) => seqLine('new', t)), f.lines, pos, occ.tier, oldLines);
    f.lines.splice(pos, oldLines.length, ...add);
    tree.now.set(p, joinFile(f));
  };
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  seq: SeqLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const isHeader = (l: string): string | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = isHeader(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    const path = line.slice(line.indexOf(': ') + 2).trim();
    const content: { n: number; text: string }[] = [];
    let j = i + 1;
    while (j < last && isHeader(lines[j]!) === null) {
      content.push({ n: j + 1, text: lines[j]! });
      j += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') edits.push(v4aAdd(path, content));
    else if (kind === 'del') {
      if (content.length > 0) throw new Exit2(`error: parse ${content[0]!.n}`);
      edits.push(v4aDelete(path));
    } else edits.push(v4aUpdate(path, headerLine, content, strict));
    i = j;
  }
  return edits;
}

function v4aAdd(p: string, content: { n: number; text: string }[]): Edit {
  const fileLines: string[] = [];
  for (const c of content) {
    if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
    else if (c.text === '') fileLines.push('');
    else throw new Exit2(`error: parse ${c.n}`);
  }
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDelete(p: string): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
  };
}

function v4aUpdate(p: string, headerLine: number, content: { n: number; text: string }[], strict: boolean): Edit {
  let moveTo: string | null = null;
  let rest = content;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (const c of rest) {
    const l = c.text;
    if (l.startsWith('@@')) {
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, seq: [], eof: false };
      chunks.push(cur);
    } else if (l === '*** End of File') {
      if (cur === null) {
        cur = { anchor: null, seq: [], eof: true };
        chunks.push(cur);
      } else cur.eof = true;
      cur = null;
    } else if (l.startsWith(' ')) {
      if (cur === null) {
        cur = { anchor: null, seq: [], eof: false };
        chunks.push(cur);
      }
      cur.seq.push(seqLine('ctx', l.slice(1)));
    } else if (l.startsWith('-')) {
      if (cur === null) {
        cur = { anchor: null, seq: [], eof: false };
        chunks.push(cur);
      }
      cur.seq.push(seqLine('old', l.slice(1)));
    } else if (l.startsWith('+')) {
      if (cur === null) {
        cur = { anchor: null, seq: [], eof: false };
        chunks.push(cur);
      }
      cur.seq.push(seqLine('new', l.slice(1)));
    } else if (l === '') {
      if (cur === null) {
        cur = { anchor: null, seq: [], eof: false };
        chunks.push(cur);
      }
      cur.seq.push(seqLine('ctx', ''));
    } else throw new Exit2(`error: parse ${c.n}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let at = -1;
        for (const tier of tiers) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (normLine(f.lines[k]!, tier) === normLine(chunk.anchor, tier)) {
              at = k;
              break;
            }
          }
          if (at >= 0) break;
        }
        if (at < 0) throw new Fail('no-match', p);
        cursor = at + 1;
      }
      const o = chunk.seq.filter((e) => e.kind !== 'new').map((e) => e.text);
      if (o.length === 0) {
        const add = buildNew(chunk.seq, f.lines, 0, 0, o);
        const pos = chunk.eof ? f.lines.length : Math.min(cursor, f.lines.length);
        f.lines.splice(pos, 0, ...add);
        cursor = pos + add.length;
        continue;
      }
      const occ = findOcc(f.lines, o, strict, cursor, chunk.eof);
      if (occ === null) throw new Fail('no-match', p);
      const pos = occ.positions[0]!;
      const add = buildNew(chunk.seq, f.lines, pos, occ.tier, o);
      f.lines.splice(pos, o.length, ...add);
      cursor = pos + add.length;
    }
    const text = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, text);
      tree.moves.push([p, moveTo]);
    } else {
      tree.now.set(p, text);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const pairs = tree.moves.filter(([o, n]) => tree.original(o) !== null && tree.original(n) === null && tree.now.get(o) === null && tree.now.get(n) !== null && o !== n);
  const paired = new Set<string>(pairs.flatMap(([o, n]) => [o, n]));
  const keyed: { key: string; text: string }[] = [];
  for (const p of changed) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    keyed.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [o, n] of pairs) keyed.push({ key: n, text: `R ${o} -> ${n}` });
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = keyed.map((r) => r.text);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
