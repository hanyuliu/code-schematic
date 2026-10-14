---
name: code-schematic
description: Write, review, render, or build from code schematics. A code schematic is a set of Markdown pseudocode documents that explains a codebase in a language-neutral notation and ties every name to the real code at a pinned commit. Use when asked to explain or document a codebase, module, or flow for developers or engineering managers; to write or review pseudocode docs; to turn schematics into an HTML site; or to write code from a schematic.
---

# Code Schematic

A code schematic explains software the way an electrical schematic explains a circuit: simpler than the real thing, in a standard notation, with every symbol tied to a real part.

Files in this skill:

- `SPEC.md`: the full standard. It is the source of truth. This file only tells you which parts to read for each task.
- `scripts/build-site/`: renders a schematic folder to a static HTML site.

Words: "the spec" means `SPEC.md`. The documents written with it are "schematics" (the system overview, module schematics, flow schematics). Do not call them specs.

## Write schematics for existing code

1. Read `SPEC.md` in full before writing anything. It is about 1,000 lines.
2. Settle the scope with the user if it is unclear: which modules, which commit, and where to write. The default folder is `schematic/` at the root of the documented repo.
3. Follow the spec's "Instructions for AI agents", section "When writing a schematic from existing code".
4. Write the system overview (`README.md`) first: modules, code map, then the rest. Then the module schematics. Then flow schematics, if a flow crosses several modules.
5. Before you finish, check every file against the spec's "Review checklist".
6. Only read the code. Do not change, build, or run the documented repo unless the user asks.

## Review schematics

1. Use the spec's "Review checklist" for each file.
2. Check the links to code at the pinned commit, for example `git show <commit>:<path> | grep -n <symbol>`:
   - every `@src` symbol exists in its file;
   - every `@test` name matches a real test;
   - every code-style name in pseudocode is real, or marked `(inline)` or `(anonymous)`.
3. Report findings per file, most serious first.

## Write code from a schematic

Follow the spec's "When writing code from a schematic". In short:

- Contracts are exact.
- Every `MUST` and `// why:` is a hard constraint.
- Every Example becomes a test.
- Open questions go back to the user.
- A name marked `(inline)` does not exist in the code, so do not call it from real code.

## Design something new

Use the spec's "Templates". Write `@files` as the paths where the code should go, and `@commit` as the commit you are designing against. Mark undecided points as Open questions.

## Render to HTML

Use this when the user wants a page to read or share. It needs Node 20 or later, git, and a local clone of the documented repo that contains the pinned commit.

```
cd <this skill>/scripts/build-site
npm install                     # first time only (installs marked)
node build.mjs --docs <schematic folder> --repo <local clone> --out <site folder>
```

The site adds:

- links from `@src` and `@test` lines to the exact lines at the pinned commit;
- links from calls and types to the section that describes them;
- colour highlighting, and folds that open invented functions in place;
- the spec as one of its pages.

Rebuild after every change to the schematics or to `@commit`. Never edit the HTML by hand. Source links use the `<repo>/blob/<sha>/<path>#L<n>` form, which works for GitHub. Other hosts may need a change in `ghFile` in `build.mjs`.

## Easy to get wrong

- A name written like code must be a real symbol. Invented names get `(inline)` on their `@src` line. Unnamed code gets `(anonymous)`.
- Every Behavior block has an `@src` line that points at a symbol, not a line number.
- Every Example says where it comes from: `@test`, `@test-e2e`, `@derived`, or `@combined`.
- Write only what the code does. When unsure, add an Open question instead of guessing.
