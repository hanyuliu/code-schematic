// Builds a static HTML site from code schematics (see ../../SPEC.md).
//
// Usage:
//   node build.mjs --docs <schematic folder> --repo <local clone of the code> --out <site folder>
//                  [--spec <path to SPEC.md>]
//
// The schematic folder must have a README.md with @repo and @commit lines. The clone must contain
// that commit; it is only read, never changed. --spec defaults to the SPEC.md next to this skill,
// and adds the spec as a page of the site. Markdown stays the source of truth. Rerun after any change.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marked, Renderer } from "marked";

const MERMAID_URL = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";

// ---------- args ----------

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
for (const key of ["docs", "repo", "out"]) {
	if (!args[key]) {
		console.error(`missing --${key}`);
		process.exit(1);
	}
}
const docsDir = path.resolve(args.docs);
const repoDir = path.resolve(args.repo);
const outDir = path.resolve(args.out);
const defaultSpec = fileURLToPath(new URL("../../SPEC.md", import.meta.url));
const specPath = args.spec ? path.resolve(args.spec) : fs.existsSync(defaultSpec) ? defaultSpec : null;

// ---------- helpers ----------

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function slugify(text) {
	return text
		.toLowerCase()
		.replace(/<[^>]+>/g, "")
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.trim()
		.replace(/\s/g, "-");
}

function plainText(md) {
	return md
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_]/g, "");
}

// Split on commas that are not inside parentheses.
function splitTopLevel(s) {
	const parts = [];
	let depth = 0;
	let cur = "";
	for (const ch of s) {
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) {
			parts.push(cur.trim());
			cur = "";
		} else cur += ch;
	}
	if (cur.trim()) parts.push(cur.trim());
	return parts;
}

// ---------- docs discovery ----------

function walk(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
		const p = path.join(dir, e.name);
		return e.isDirectory() ? walk(p) : e.name.endsWith(".md") ? [p] : [];
	});
}

const docs = walk(docsDir).map((abs) => {
	const rel = path.relative(docsDir, abs).split(path.sep).join("/");
	const md = fs.readFileSync(abs, "utf8");
	const page = rel === "README.md" ? "index.html" : rel.replace(/\.md$/, ".html");
	const h1 = (md.match(/^# (.+)$/m) || [, rel])[1];
	const title = plainText(h1).replace(/^(Module|Flow):\s*/, "");
	const moduleName = (md.match(/^@(?:module|flow)\s+(\S+)/m) || [])[1];
	return { rel, abs, md, page, title, moduleName, kind: /^# Flow:/m.test(md) ? "flow" : "module" };
});
if (specPath) {
	docs.push({
		rel: "@spec",
		abs: specPath,
		md: fs.readFileSync(specPath, "utf8"),
		page: "spec.html",
		title: "Code Schematic spec",
		kind: "spec",
	});
}
const byRel = new Map(docs.map((d) => [d.rel, d]));
const byModule = new Map(docs.filter((d) => d.moduleName).map((d) => [d.moduleName, d]));

const readme = byRel.get("README.md");
if (!readme) throw new Error("docs folder needs a README.md");
const repoLine = (readme.md.match(/^@repo\s+(\S+)/m) || [])[1];
const commitLine = (readme.md.match(/^@commit\s+(\S+)/m) || [])[1];
if (!repoLine || !commitLine) throw new Error("README.md needs @repo and @commit");

const repoWeb = repoLine
	.replace(/^git@([^:]+):/, "https://$1/")
	.replace(/\.git$/, "");
const sha = execFileSync("git", ["-C", repoDir, "rev-parse", commitLine], { encoding: "utf8" }).trim();
const shortSha = sha.slice(0, 9);

// Module prefixes used in pseudocode, e.g. `jobQueue.` from the README table or camelCased module names.
const prefixes = new Set();
for (const m of readme.md.matchAll(/`([a-z][A-Za-z0-9]*)\.`/g)) prefixes.add(m[1]);
for (const name of byModule.keys()) prefixes.add(name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));

// Nav order: the order docs are first linked from the README.
const navOrder = [];
for (const m of readme.md.matchAll(/\]\(([^)#]+\.md)/g)) {
	const rel = path.posix.normalize(m[1]);
	if (byRel.has(rel) && !navOrder.includes(rel)) navOrder.push(rel);
}
for (const d of docs) if (d.rel !== "README.md" && d.rel !== "@spec" && !navOrder.includes(d.rel)) navOrder.push(d.rel);

// ---------- definition index ----------
//
// Maps names used in pseudocode to the doc section that describes them, so calls and
// types can link to their own Behavior block or Contracts line.

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})\s*([\w-]*)\s*$/;
const TYPE_DEF = /^\s*(?:type|interface|class)\s+([A-Z][\w$]*)/;

const fnIndex = new Map(); // name or Class.method -> [{ doc, id, label }]
const typeIndex = new Map(); // TypeName -> { doc, id }

function addFn(name, entry) {
	const list = fnIndex.get(name) || [];
	if (!list.some((e) => e.doc === entry.doc && e.id === entry.id)) list.push(entry);
	fnIndex.set(name, list);
}

// Walks a doc's markdown outside code fences, giving each heading the same id the renderer will use.
function scanDoc(doc) {
	const used = new Map();
	doc.headingIds = [];
	let last = null;
	let pendingInline = null;
	const lines = doc.md.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const fence = lines[i].match(FENCE);
		if (fence) {
			const close = new RegExp(`^ {0,3}${escRe(fence[2][0])}{${fence[2].length},}\\s*$`);
			let j = i + 1;
			for (; j < lines.length && !close.test(lines[j]); j++) {
				const t = !fence[3] && doc.kind !== "spec" && lines[j].match(TYPE_DEF);
				if (t && !typeIndex.has(t[1])) typeIndex.set(t[1], { doc, id: `def-${t[1]}` });
			}
			if (pendingInline && !fence[3]) {
				pendingInline.inline.code = lines.slice(i + 1, j).join("\n");
				pendingInline = null;
			}
			i = j;
			continue;
		}
		const h = lines[i].match(HEADING);
		if (h) {
			let id = slugify(plainText(h[2]));
			const n = used.get(id) || 0;
			used.set(id, n + 1);
			if (n) id = `${id}-${n}`;
			doc.headingIds.push(id);
			last = { id, text: plainText(h[2]) };
			pendingInline = null;
			continue;
		}
		const inl = /^@src\s.*\(inline\)/.test(lines[i]) && last && doc.kind !== "spec" && /^[\w$]+$/.test(last.text);
		if (inl) {
			// An invented name stands for part of a real function. Index only the name, and keep its
			// pseudocode so callers can unfold it in place.
			const parent = (lines[i].match(/#([\w.$]+)\s*\(inline\)/) || [])[1] || "";
			const entry = { doc, id: last.id, label: last.text, inline: { parent, code: "" } };
			addFn(last.text, entry);
			pendingInline = entry;
		} else if (/^@src\s/.test(lines[i]) && last && doc.kind !== "spec") {
			const entry = { doc, id: last.id, label: last.text };
			if (/^[\w.$]+$/.test(last.text)) addFn(last.text, entry);
			for (const m of lines[i].matchAll(/#([\w.$]+)/g)) {
				addFn(m[1], entry);
				addFn(m[1].split(".").pop(), entry);
			}
		}
	}
}
for (const d of docs) scanDoc(d);

// Pseudocode prefix -> module doc, from the README table ("| job-queue | `jobQueue.` |") or camelCased names.
const prefixDoc = new Map();
for (const [name, d] of byModule) prefixDoc.set(name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()), d);
for (const m of readme.md.matchAll(/^\|\s*([\w-]+)\s*\|\s*`(\w+)\.`/gm)) if (byModule.has(m[1])) prefixDoc.set(m[2], byModule.get(m[1]));

// Picks the section a call refers to: a module prefix wins, then the same module doc, then a unique
// match in module docs (so flows link to the module that explains a function), then the same flow.
function pick(list, doc) {
	const same = list.find((e) => e.doc === doc);
	if (same && doc.kind === "module") return same;
	const mods = list.filter((e) => e.doc.kind === "module");
	if (mods.length === 1) return mods[0];
	return same || (list.length === 1 ? list[0] : null);
}

function resolveFn(name, doc, receiver) {
	if (doc.kind === "spec") return null;
	if (receiver && prefixDoc.has(receiver)) {
		const target = prefixDoc.get(receiver);
		return (fnIndex.get(name) || []).find((e) => e.doc === target) || null;
	}
	if (receiver && /^[A-Z]/.test(receiver)) {
		return pick(fnIndex.get(`${receiver}.${name}`) || [], doc);
	}
	if (receiver) return null;
	return pick(fnIndex.get(name) || [], doc);
}

function resolveType(name, doc) {
	return doc.kind === "spec" ? null : typeIndex.get(name) || null;
}

const sectionHref = (from, entry) => (entry.doc === from ? "" : pageHref(from, entry.doc)) + `#${entry.id}`;

// ---------- repository lookups ----------

const fileCache = new Map();
function repoFile(p) {
	if (!fileCache.has(p)) {
		try {
			fileCache.set(p, execFileSync("git", ["-C", repoDir, "show", `${sha}:${p}`], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).split("\n"));
		} catch {
			fileCache.set(p, null);
		}
	}
	return fileCache.get(p);
}

const MODS = "(?:(?:export|default|public|private|protected|internal|static|async|readonly|override|abstract|get|set|declare|open|suspend|final)\\s+)*";

function findDef(lines, name, from = 0, allowLoose = true) {
	const n = escRe(name);
	const pats = [
		new RegExp(`\\b(?:function\\*?|class|interface|type|enum|def|fun|func|struct|trait|object|record)\\s+${n}\\b`),
		new RegExp(`\\b(?:const|let|var|val)\\s+${n}\\b`),
		new RegExp(`^\\s*${MODS}${n}\\s*(?:<[^>]*>)?\\s*\\(`),
		new RegExp(`^\\s*${MODS}${n}\\s*[?!]?\\s*[:=]`),
	];
	for (const pat of pats) {
		for (let i = from; i < lines.length; i++) if (pat.test(lines[i])) return i;
	}
	if (!allowLoose) return -1;
	const loose = new RegExp(`\\b${n}\\b`);
	for (let i = from; i < lines.length; i++) if (loose.test(lines[i])) return i;
	return -1;
}

// Returns a 1-based line for "Class.method" or "factory.execute", or null.
function symbolLine(file, dotted, strict = false) {
	const lines = repoFile(file);
	if (!lines) return null;
	let at = 0;
	let found = -1;
	for (const part of dotted.split(".")) {
		const i = findDef(lines, part, at, !strict);
		if (i < 0) break;
		found = i;
		at = i;
	}
	return found < 0 ? null : found + 1;
}

function testLine(file, name) {
	const lines = repoFile(file);
	if (!lines) return null;
	const i = lines.findIndex((l) => l.includes(name));
	return i < 0 ? null : i + 1;
}

const ghFile = (file, line) => `${repoWeb}/blob/${sha}/${file}${line ? `#L${line}` : ""}`;

const missing = [];

// ---------- annotation lines ----------

function pageHref(fromDoc, toDoc, hash = "") {
	const fromDir = path.posix.dirname(fromDoc.page);
	return path.posix.relative(fromDir, toDoc.page) + hash;
}

function renderSrc(line, doc, state) {
	// "@src a.ts#f, #g (inline); b.ts#Cls.m (anonymous)"
	const body = line.replace(/^@src\s+/, "");
	const groups = [];
	let curFile = null;
	state.srcFiles = [];
	for (const m of body.matchAll(/([\w./@-]+\.[\w]+)?#([\w.$]+)(?:\s*\((inline|anonymous)\))?/g)) {
		if (m[1]) {
			curFile = m[1];
			groups.push({ file: curFile, syms: [] });
			state.srcFiles.push(curFile);
		}
		if (!curFile) continue;
		let ln = symbolLine(curFile, m[2], true);
		if (!ln) {
			ln = symbolLine(curFile, m[2]);
			missing.push(`${doc.rel}: @src ${curFile}#${m[2]} ${ln ? `(no definition found, linked to first mention at L${ln})` : "(not found, linked to file)"}`);
		}
		groups.at(-1).syms.push({ name: m[2], marker: m[3], href: ghFile(curFile, ln) });
	}
	const parts = groups.map(
		(g) =>
			`<span class="src-file"><a href="${esc(ghFile(g.file))}" title="${esc(g.file)}">${esc(path.posix.basename(g.file))}</a>` +
			g.syms
				.map(
					(s) =>
						` <span class="src-sep">›</span> <a class="src-sym" href="${esc(s.href)}">${esc(s.name)}</a>` +
						(s.marker ? ` <span class="marker" title="${s.marker === "inline" ? "Not a real function: a named part of the function above" : "Unnamed code inside the symbol above"}">${s.marker}</span>` : ""),
				)
				.join("") +
			`</span>`,
	);
	return `<div class="src"><span class="lbl">Source</span>${parts.join("")}</div>`;
}

function renderExampleSource(line, doc) {
	const tag = line.match(/^@([\w-]+)/)[1];
	const labels = { test: "Test", "test-e2e": "E2E test", derived: "Derived from code", combined: "Combined from tests" };
	const label = labels[tag] || tag;
	if (tag !== "test" && tag !== "test-e2e") {
		return `<div class="exsrc exsrc-${tag}"><span class="lbl">${esc(label)}</span><span class="exsrc-note">${tag === "derived" ? "no single test covers this" : "joins several tests"}</span></div>`;
	}
	let curFile = null;
	const items = [];
	for (const m of line.matchAll(/([\w./@-]+\.[\w]+)?#"((?:[^"\\]|\\.)*)"/g)) {
		if (m[1]) curFile = m[1];
		if (!curFile) continue;
		const ln = testLine(curFile, m[2]);
		if (!ln) missing.push(`${doc.rel}: @${tag} ${curFile}#"${m[2]}"`);
		items.push(
			`<a href="${esc(ghFile(curFile, ln))}" title="${esc(curFile)}">${esc(path.posix.basename(curFile))} <span class="src-sep">›</span> “${esc(m[2])}”</a>`,
		);
	}
	return `<div class="exsrc exsrc-${tag}"><span class="lbl">${esc(label)}</span>${items.join('<span class="src-sep">,</span> ')}</div>`;
}

function renderMeta(lines, doc) {
	const rows = lines.map((l) => {
		const m = l.match(/^@([\w-]+)\s+(.*)$/);
		const key = m[1];
		const val = m[2].trim();
		let html;
		if (key === "files") {
			html = splitTopLevel(val)
				.map((item) => {
					const [, p, note] = item.match(/^(\S+)\s*(.*)$/);
					const link = repoFile(p) ? `<a href="${esc(ghFile(p))}">${esc(p)}</a>` : esc(p);
					return `<span class="meta-item">${link}${note ? ` <span class="meta-note">${esc(note)}</span>` : ""}</span>`;
				})
				.join("");
		} else if (["depends", "used-by", "modules"].includes(key)) {
			html = splitTopLevel(val)
				.map((item) => {
					const [, name, rest] = item.match(/^([\w-]+)(.*)$/) || [, item, ""];
					const target = byModule.get(name);
					const label = target ? `<a href="${esc(pageHref(doc, target))}">${esc(name)}</a>` : esc(name);
					return `<span class="meta-item">${label}${rest ? `<span class="meta-note">${esc(rest)}</span>` : ""}</span>`;
				})
				.join("");
		} else if (key === "repo") {
			html = `<a href="${esc(repoWeb)}">${esc(repoWeb.replace(/^https:\/\//, ""))}</a>`;
		} else if (key === "commit") {
			html = `<a href="${esc(`${repoWeb}/tree/${sha}`)}"><code>${esc(shortSha)}</code></a>`;
		} else {
			html = esc(val);
		}
		return `<dt>${esc(key)}</dt><dd>${html}</dd>`;
	});
	return `<dl class="meta">${rows.join("")}</dl>`;
}

// ---------- pseudocode highlighter ----------

const KW = new Set([
	"fn", "async", "await", "if", "else", "for", "while", "loop", "match", "try", "catch", "finally", "return", "throw",
	"break", "continue", "spawn", "emit", "otherwise", "new", "yield",
]);
const LINE_START_KW = new Set(["type", "interface", "class", "on", "lock", "extends"]);
const LITERALS = new Set(["true", "false", "null", "undefined", "empty"]);

const span = (cls, text) => `<span class="t-${cls}">${esc(text)}</span>`;

function commentStart(line) {
	let q = null;
	for (let i = 0; i < line.length - 1; i++) {
		const c = line[i];
		if (q) {
			if (c === "\\") i++;
			else if (c === q) q = null;
		} else if (c === '"' || c === "'" || c === "`") q = c;
		else if (c === "/" && line[i + 1] === "/" && line[i - 1] !== ":") return i;
	}
	return -1;
}

function resolveHelper(name, state) {
	for (const f of state.srcFiles || []) {
		const ln = symbolLine(f, name, true);
		if (ln) return ghFile(f, ln);
	}
	for (const f of state.docFiles || []) {
		const ln = symbolLine(f, name, true);
		if (ln) return ghFile(f, ln);
	}
	return null;
}

function hlComment(com, state) {
	let m = com.match(/^(\/\/\s*)(why)(\s*\([^)]*\))?(:?)(.*)$/);
	if (m) return `<span class="t-why"><span class="t-why-lbl">${esc(m[1] + m[2] + (m[3] || "") + m[4])}</span>${esc(m[5])}</span>`;
	m = com.match(/^(\/\/\s*→\s*)([\w.$]+)(.*)$/);
	if (m) {
		const href = resolveHelper(m[2], state);
		const name = href ? `<a class="t-ref" href="${esc(href)}">${esc(m[2])}</a>` : span("ref", m[2]);
		return `<span class="t-comment">${esc(m[1])}</span>${name}<span class="t-comment">${esc(m[3])}</span>`;
	}
	m = com.match(/^(\/\/\s*)(note|todo)(:)(.*)$/);
	if (m) return `<span class="t-comment"><span class="t-note-lbl">${esc(m[1] + m[2] + m[3])}</span>${esc(m[4])}</span>`;
	return span("comment", com);
}

function hlCode(code, ctx) {
	let out = "";
	let rest = code;
	let m = rest.match(/^(\s*)(MUST NOT|MUST|SHOULD NOT|SHOULD|MAY)\b/);
	if (m) {
		const strength = m[2].startsWith("MUST") ? "must" : m[2].startsWith("SHOULD") ? "should" : "may";
		out += esc(m[1]) + span(`rule-${strength}`, m[2]);
		rest = rest.slice(m[0].length);
	} else if ((m = rest.match(/^(\s*)(GIVEN|WHEN|THEN|AND)\b/))) {
		out += esc(m[1]) + span("example", m[2]);
		rest = rest.slice(m[0].length);
	}
	const toks = [...rest.matchAll(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|(\s+)|([\s\S])/g)];
	let prevWord = null;
	let firstWord = !out;
	for (let k = 0; k < toks.length; k++) {
		const [whole, str, num, word] = toks[k];
		if (str) {
			out += span("literal", whole);
			firstWord = false;
			continue;
		}
		if (num) {
			out += span("literal", whole);
			firstWord = false;
			continue;
		}
		if (!word) {
			out += esc(whole);
			continue;
		}
		const before = rest.slice(0, toks[k].index).replace(/\s+$/, "");
		const prevChar = before.at(-1) || "";
		const after = rest.slice(toks[k].index + word.length);
		const nextChar = after.trimStart()[0] || "";
		let cls = "plain";
		if (prevChar === "." && rest[toks[k].index - 1] === ".") cls = "symbol";
		else if (prefixes.has(word) && after[0] === "." && /^\.[A-Za-z_$]/.test(after)) cls = "module";
		else if (KW.has(word) || (word === "each" && prevWord === "for") || (firstWord && LINE_START_KW.has(word))) cls = "keyword";
		else if (LITERALS.has(word)) cls = "literal";
		else if (/^[A-Z]/.test(word) && (/^[A-Z][A-Z0-9_]+$/.test(word) && word.length > 1)) cls = "symbol";
		else if (/^[A-Z]/.test(word) && (/[A-Z]/.test(word.slice(1)) || ".(<{[?|>,".includes(after[0] || "") || ":<|,(=>".includes(prevChar) || word.length === 1))
			cls = "type";
		else if (/^\?\(|^\(/.test(after)) cls = "symbol";
		else if (/[a-z][A-Z]/.test(word) || /_/.test(word.replace(/^_+/, "x")) || word.startsWith("_")) cls = "symbol";
		let html = cls === "plain" ? esc(word) : span(cls, word);
		if (ctx && ctx.doc.kind !== "spec") {
			const receiverMatch = before.match(/([A-Za-z_$][\w$]*)\s*\.$/);
			const receiver = rest[toks[k].index - 1] === "." && receiverMatch ? receiverMatch[1] : null;
			const isCall = /^\??\(/.test(after);
			if (/^[A-Z]/.test(word) && /^(type|interface|class)$/.test(prevWord || "") && typeIndex.get(word)?.doc === ctx.doc && !ctx.defIds.has(word)) {
				ctx.defIds.add(word);
				html = `<span class="t-type t-def" id="def-${esc(word)}">${esc(word)}</span>`;
			} else if (cls === "type") {
				const t = resolveType(word, ctx.doc);
				if (t) html = `<a class="t-type t-link" href="${esc(sectionHref(ctx.doc, t))}" title="${esc(word)} · ${esc(t.doc.title)}">${esc(word)}</a>`;
			} else if (cls === "symbol" && (isCall || (receiver && prefixDoc.has(receiver))) && prevWord !== "fn") {
				const e = resolveFn(word, ctx.doc, receiver);
				if (e && !(e.doc === ctx.doc && e.id === ctx.headingId)) {
					html = e.inline
						? `<a class="t-symbol t-link t-inline" href="${esc(sectionHref(ctx.doc, e))}" title="${esc(inlineTitle(e))}">${esc(word)}</a>`
						: `<a class="t-symbol t-link" href="${esc(sectionHref(ctx.doc, e))}" title="${esc(e.label)} · ${esc(e.doc.title)}">${esc(word)}</a>`;
				}
			}
		}
		out += html;
		prevWord = word;
		firstWord = false;
		void nextChar;
	}
	return out;
}

function highlight(code, doc, state) {
	const ctx = { doc, headingId: state.headingId, defIds: state.defIds };
	const lines = code.replace(/\n$/, "").split("\n");
	const isCodeMap = lines.some((l) => /→\s*[\w./-]+\.md/.test(l));
	if (isCodeMap) {
		return lines
			.map((l) =>
				esc(l).replace(/→(\s*)([\w./-]+\.md)/g, (whole, sp, target) => {
					const rel = path.posix.normalize(path.posix.join(path.posix.dirname(doc.rel), target));
					const t = byRel.get(rel);
					return t ? `<span class="t-comment">→</span>${sp}<a class="t-ref" href="${esc(pageHref(doc, t))}">${target}</a>` : whole;
				}),
			)
			.join("\n");
	}
	// A comment-only line right under a "// why:" at the same column continues it.
	let whyCol = -1;
	const depth = state.foldDepth || 0;
	return lines
		.map((line) => {
			const fold = depth < 2 && foldTarget(line, ctx);
			if (fold) {
				whyCol = -1;
				return foldHtml(line, fold, doc, state, depth);
			}
			const i = commentStart(line);
			if (i < 0) {
				whyCol = -1;
				return hlCode(line, ctx);
			}
			const com = line.slice(i);
			if (i === whyCol && !line.slice(0, i).trim() && !/^\/\/\s*(why|note|todo|→)/.test(com)) {
				return esc(line.slice(0, i)) + span("why", com);
			}
			whyCol = /^\/\/\s*why\b/.test(com) ? i : -1;
			return hlCode(line.slice(0, i), ctx) + hlComment(com, state);
		})
		.map((html, k, all) => html + (k < all.length - 1 && !html.endsWith("</details>") ? "\n" : ""))
		.join("");
}

const inlineTitle = (e) => `Not in the code: a named part of ${e.inline.parent || "the function above"}`;

// The invented function a line calls, if any. Only plain calls fold, never a method on another object.
function foldTarget(line, ctx) {
	if (ctx.doc.kind === "spec") return null;
	const i = commentStart(line);
	const code = i < 0 ? line : line.slice(0, i);
	for (const m of code.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)\s*\??\(/g)) {
		const e = resolveFn(m[2], ctx.doc, null);
		if (e && e.inline && e.inline.code && !(e.doc === ctx.doc && e.id === ctx.headingId)) return e;
	}
	return null;
}

// A call line that opens to show the pseudocode it stands for, indented under the call.
function foldHtml(line, e, doc, state, depth) {
	// The opened lines go in a box that starts under the call, with no extra indent, so they do not
	// read as a nested block. A header and footer in body text say where the lines come from.
	const col = line.match(/^\s*/)[0].length;
	const body = e.inline.code.split("\n");
	const sig = body.findIndex((l) => /^\s*(async\s+)?fn\s/.test(l));
	const rest = body.slice(sig + 1);
	while (rest.length && !rest.at(-1).trim()) rest.pop();
	const base = Math.min(...rest.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
	const shifted = rest.map((l) => (l.trim() ? l.slice(base) : "")).join("\n");
	const inner = highlight(shifted, doc, { ...state, foldDepth: depth + 1 }).replace(
		/<span class="t-keyword">return<\/span>/g,
		'<span class="t-keyword t-return" title="Goes back to the call line above, not out of the whole function">return</span>',
	);
	const parent = esc(e.inline.parent || "the function above");
	const href = sectionHref(doc, e);
	const head = `<span class="fold-head"><a class="t-inline-head" href="${esc(href)}">${esc(e.label)}</a> <span>· not in the code, these ${rest.length} lines are part of ${parent}</span></span>`;
	const foot = `<span class="fold-foot">end of ${esc(e.label)} · back to the call</span>`;
	const i = commentStart(line);
	const summary = i < 0 ? hlCode(line, { ...state, doc }) : hlCode(line.slice(0, i), { ...state, doc }) + hlComment(line.slice(i), state);
	return `<details class="fold"><summary title="Show the ${rest.length} lines this name stands for">${summary}</summary><span class="fold-body" style="margin-left:${col}ch">${head}<span class="fold-code">${inner}</span>${foot}</span></details>`;
}

// ---------- markdown preprocessing ----------

const META_KEYS = /^@(module|files|depends|used-by|flow|modules|repo|commit)\b/;

function preprocess(doc) {
	const state = { srcFiles: [], docFiles: [], headingId: null, hIdx: 0, defIds: new Set() };
	const fm = doc.rel !== "@spec" && doc.md.match(/^@files\s+(.+)$/m);
	if (fm) state.docFiles = splitTopLevel(fm[1]).map((x) => x.split(/\s/)[0]);
	const src = doc.md.split("\n");
	const out = [];
	for (let i = 0; i < src.length; i++) {
		const line = src[i];
		const fence = line.match(/^( {0,3})(`{3,}|~{3,})\s*([\w-]*)\s*$/);
		if (fence) {
			const marker = fence[2];
			const lang = fence[3];
			const body = [];
			let j = i + 1;
			const close = new RegExp(`^ {0,3}${escRe(marker[0])}{${marker.length},}\\s*$`);
			while (j < src.length && !close.test(src[j])) body.push(src[j++]);
			const code = body.join("\n");
			if (lang === "mermaid") {
				out.push("", `<pre class="mermaid">${esc(code)}</pre>`, "");
			} else if (!lang) {
				const hl = highlight(code, doc, state);
				const tools = hl.includes('<details class="fold">') ? `<div class="fold-tools"><button type="button" data-fold="open">open all ▸</button></div>` : "";
				out.push("", `${tools}<pre class="pc"><code>${hl}</code></pre>`, "");
			} else {
				out.push("", `<pre class="raw" data-lang="${esc(lang)}"><code>${esc(code)}</code></pre>`, "");
			}
			i = j;
			continue;
		}
		if (HEADING.test(line)) state.headingId = doc.headingIds[state.hIdx++];
		if (META_KEYS.test(line)) {
			const group = [];
			while (i < src.length && /^@[\w-]+\s/.test(src[i]) && META_KEYS.test(src[i])) group.push(src[i++].replace(/\s+\(local copy:.*\)$/, ""));
			i--;
			out.push("", renderMeta(group, doc), "");
			continue;
		}
		if (/^@src\s/.test(line)) {
			out.push("", renderSrc(line, doc, state), "");
			continue;
		}
		if (/^@(test|test-e2e|derived|combined)\b/.test(line)) {
			out.push("", renderExampleSource(line, doc), "");
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

// ---------- markdown rendering ----------

function renderDoc(doc) {
	const headings = [];
	const used = new Map();
	let hIdx = 0;
	let inHeading = false;
	let currentHeading = null;
	const marked = new Marked({ gfm: true });
	marked.use({
		renderer: {
			heading({ tokens, depth, text }) {
				let id = doc.headingIds[hIdx++];
				if (!id) {
					id = slugify(plainText(text));
					const n = used.get(id) || 0;
					used.set(id, n + 1);
					if (n) id = `${id}-${n}`;
				}
				inHeading = true;
				const inner = this.parser.parseInline(tokens);
				inHeading = false;
				currentHeading = id;
				headings.push({ depth, id, html: inner });
				return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${depth}>\n`;
			},
			link({ href, title, tokens }) {
				const inner = this.parser.parseInline(tokens);
				let target = href;
				const m = href.match(/^([^#:]+\.md)(#.*)?$/);
				if (m) {
					const rel = path.posix.normalize(path.posix.join(path.posix.dirname(doc.rel === "@spec" ? "x" : doc.rel), m[1]));
					const t = byRel.get(rel);
					if (t) target = pageHref(doc, t, m[2] || "");
				}
				const ext = /^https?:/.test(target) ? ' target="_blank" rel="noopener"' : "";
				return `<a href="${esc(target)}"${title ? ` title="${esc(title)}"` : ""}${ext}>${inner}</a>`;
			},
			table(token) {
				const html = Renderer.prototype.table.call(this, token);
				return `<div class="table-wrap">${html}</div>`;
			},
			codespan({ text }) {
				if (specPath && (text === path.basename(specPath) || text === "SPEC.md") && doc.rel !== "@spec") {
					return `<a href="${esc(pageHref(doc, byRel.get("@spec")))}"><code>${text}</code></a>`;
				}
				const m = !inHeading && text.match(/^([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?(?:\(\))?$/);
				if (m) {
					const [, a, b] = m;
					const e = b ? resolveFn(b, doc, a) : /^[A-Z]/.test(a) ? resolveType(a, doc) || resolveFn(a, doc) : resolveFn(a, doc);
					if (e && !(e.doc === doc && e.id === currentHeading)) {
						return e.inline
							? `<a class="code-link t-inline" href="${esc(sectionHref(doc, e))}" title="${esc(inlineTitle(e))}"><code>${text}</code></a>`
							: `<a class="code-link" href="${esc(sectionHref(doc, e))}"><code>${text}</code></a>`;
					}
				}
				return `<code>${text}</code>`;
			},
		},
	});
	const html = marked.parse(preprocess(doc));
	return { html, headings };
}

// ---------- page shell ----------

function navHtml(doc, headings) {
	const rel = (t) => esc(pageHref(doc, t));
	const item = (t, label) =>
		`<li><a href="${rel(t)}"${t === doc ? ' aria-current="page"' : ""}>${esc(label)}</a>${t === doc ? tocHtml(headings) : ""}</li>`;
	const groups = new Map();
	for (const r of navOrder) {
		const t = byRel.get(r);
		const g = r.includes("/") ? r.split("/")[0] : "";
		if (!groups.has(g)) groups.set(g, []);
		groups.get(g).push(t);
	}
	let html = `<ul class="nav-list">${item(readme, "Overview")}</ul>`;
	for (const [g, items] of groups) {
		html += `<p class="nav-group">${esc(g || "docs")}</p><ul class="nav-list">${items.map((t) => item(t, t.title)).join("")}</ul>`;
	}
	if (specPath) html += `<p class="nav-group">standard</p><ul class="nav-list">${item(byRel.get("@spec"), "Code Schematic spec")}</ul>`;
	return html;
}

function tocHtml(headings) {
	const hs = headings.filter((h) => h.depth === 2 || h.depth === 3);
	if (hs.length < 2) return "";
	return `<ul class="toc">${hs.map((h) => `<li class="toc-${h.depth}"><a href="#${h.id}">${h.html.replace(/<a [^>]*>|<\/a>/g, "")}</a></li>`).join("")}</ul>`;
}

const LEGEND = `<div class="legend" aria-label="Color legend">
<p class="nav-group">reading the code</p>
<ul>
<li><span class="t-symbol">blue</span> code name, search the code for it</li>
<li><span class="t-symbol t-inline">italic</span> named for reading, not in the code; ▸ opens it</li>
<li><span class="t-type">teal</span> type or class</li>
<li><span class="t-module">orange</span> crosses into another module</li>
<li><span class="t-keyword">bold</span> structure</li>
<li>plain text is a summary</li>
<li><span class="t-rule-must">MUST</span> <span class="t-rule-should">SHOULD</span> <span class="t-rule-may">MAY</span> rule strength</li>
<li><span class="t-why"><span class="t-why-lbl">// why:</span></span> keep this behavior</li>
</ul></div>`;

function shell(doc, { html, headings }) {
	const root = path.posix.relative(path.posix.dirname(doc.page), ".") || ".";
	const pageTitle = doc === readme ? doc.title : `${doc.title} · ${readme.title}`;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(pageTitle)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@400;600&family=Atkinson+Hyperlegible+Next:ital,wght@0,400;0,600;0,700;1,400&display=swap">
<link rel="stylesheet" href="${root}/style.css">
</head>
<body>
<div class="layout">
<aside class="rail">
<details class="rail-inner" open>
<summary><a class="brand" href="${esc(pageHref(doc, readme))}">${esc(readme.title)}</a>
<span class="snapshot"><a href="${esc(`${repoWeb}/tree/${sha}`)}" target="_blank" rel="noopener">${esc(repoWeb.split("/").pop())} @ <code>${esc(shortSha)}</code></a></span></summary>
<nav>${navHtml(doc, headings)}</nav>
${LEGEND}
</details>
</aside>
<main class="doc doc-${doc.kind}">
${html}
</main>
</div>
<script src="${MERMAID_URL}"></script>
<script>
(function () {
  try {
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    window.mermaid.initialize({ startOnLoad: true, theme: dark ? "dark" : "neutral", securityLevel: "strict" });
  } catch (e) {}
  var rail = document.querySelector(".rail-inner");
  if (rail && window.matchMedia("(max-width: 900px)").matches) rail.open = false;
  document.querySelectorAll(".fold-tools button").forEach(function (b) {
    var pre = b.parentElement.nextElementSibling;
    b.addEventListener("click", function () {
      var open = b.dataset.fold === "open";
      pre.querySelectorAll("details.fold").forEach(function (d) { d.open = open; });
      b.dataset.fold = open ? "close" : "open";
      b.textContent = open ? "close all ▾" : "open all ▸";
    });
  });
})();
</script>
</body>
</html>
`;
}

// ---------- build ----------

fs.rmSync(outDir, { recursive: true, force: true });
for (const doc of docs) {
	const target = path.join(outDir, doc.page);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, shell(doc, renderDoc(doc)));
}
fs.copyFileSync(new URL("./style.css", import.meta.url), path.join(outDir, "style.css"));

console.log(`built ${docs.length} pages into ${path.relative(process.cwd(), outDir) || outDir}`);
console.log(`snapshot ${repoWeb} @ ${shortSha}`);
if (missing.length) {
	console.log(`\n${missing.length} anchors not found in the repo (linked to the file instead):`);
	for (const m of missing) console.log(`  ${m}`);
}
