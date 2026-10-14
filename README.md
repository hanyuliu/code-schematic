# code-schematic

A pseudocode standard and agent skill for explaining codebases. Language-neutral notation, every name linked to the real code at a pinned commit, readable by developers and managers, and usable by coding agents. Each schematic set is Markdown for agents and an HTML site for people.

A code schematic works like an electrical schematic. It is simpler than the real thing, it uses a standard notation, and every symbol in it stands for a real part of the code. Developers and engineering managers read it to understand a system. Coding agents (Claude, Copilot, Codex, and others) use it to explain existing code or to build new code from a design.

- **Language-neutral.** One notation for Java, Kotlin, Python, TypeScript, Go, C#, Rust, and similar languages.
- **Tied to the real code.** A name written like code is a real symbol. Every block points to its source with `@src`, and every schematic is pinned to a commit.
- **Readable at every level.** A system overview for managers, module and flow schematics for developers, and Given/When/Then examples that can become tests.
- **An HTML site for people, Markdown for agents.** The skill builds the schematics into pages where calls link to their sections, `@src` lines link to the exact lines of code, and pseudocode is colour-highlighted. The Markdown stays the source of truth that agents read and edit.

## What it looks like

````markdown
# Module: rate-limiter

> Lets each client make at most N requests per time window. Rejects the rest.

@module   rate-limiter
@files    src/ratelimit/RateLimiter.kt

## Behavior

@src src/ratelimit/RateLimiter.kt#tryAcquire

```
fn tryAcquire(clientId) -> Bool
    bucket = buckets[clientId] or new Bucket(start = clock.now(), count = 0)
    if clock.now() - bucket.start >= window:
        bucket = new Bucket(start = clock.now(), count = 0)    // window expired, reset
    if bucket.count >= limit:
        return false
    bucket.count += 1
    return true
```

## Rules

```
MUST     count each client separately
MUST NOT read the system clock directly    // why: tests need a fake clock
```
````

The full standard is in [SPEC.md](plugins/code-schematic/skills/code-schematic/SPEC.md).

## Install

### Claude Code (plugin)

In a Claude Code session:

```
/plugin marketplace add hanyuliu/code-schematic
/plugin install code-schematic@code-schematic-tools
```

To get updates, run `/plugin marketplace update code-schematic-tools`, or turn on auto-update under Marketplaces in `/plugin`.

If the repository is private, you need read access to it and git credentials already stored on your machine. For GitHub, run `gh auth login` and then `gh auth setup-git`.

### Any agent that reads skill folders

Copy the skill folder into your agent's skills directory. For Claude Code:

```
git clone https://github.com/hanyuliu/code-schematic
cp -r code-schematic/plugins/code-schematic/skills/code-schematic ~/.claude/skills/
```

Use `<project>/.claude/skills/` instead to install it for one project only.

### People without an agent

Read [SPEC.md](plugins/code-schematic/skills/code-schematic/SPEC.md). It is written for people first.

## Use

Ask your agent in plain words. For example:

- "Write a code schematic for the billing module of this repo."
- "Write schematics for the request path from login to the first page load."
- "Review the schematics in `schematic/` against the code."
- "Implement the job queue described in `schematic/jobs/job-queue.md`."
- "Rebuild the HTML site for `schematic/`."

In Claude Code you can also call the skill directly with `/code-schematic:code-schematic`.

By default, schematics go in a `schematic/` folder at the root of the documented repo. They are Markdown, so they live next to the code and are reviewed like code. When the agent writes or changes schematics, it also builds the HTML site into `schematic/_site/` and gives you the path to `index.html`. The site is kept out of git. Say "Markdown only" if you do not want it.

## The HTML site

The agent builds the site for you. To build it yourself, you need Node 20 or later, git, and a local clone of the documented repo that contains the pinned commit. The build only reads the clone.

```
SITE=plugins/code-schematic/skills/code-schematic/scripts/build-site
npm ci --prefix $SITE                      # first time only
node $SITE/build.mjs --docs <schematic folder>
```

By default the build uses the git repo that holds the schematic folder, and writes the site to `<schematic folder>/_site/` with a `.gitignore` so it is not committed. Use `--repo <local clone>` when the schematics live outside the code's repo, and `--out <folder>` to write the site somewhere else (for example to publish it). The build refuses to delete an `--out` folder that is not empty and that it did not make.

Rebuild after every change to the schematics or to `@commit`. Never edit the HTML by hand. Source links use the GitHub form `<repo>/blob/<sha>/<path>#L<n>`.

## Repository layout

```
.claude-plugin/marketplace.json            makes this repo a Claude Code plugin marketplace
plugins/code-schematic/
  .claude-plugin/plugin.json               plugin name and version
  skills/code-schematic/
    SKILL.md                               what the agent does for each task
    SPEC.md                                the standard
    scripts/build-site/                    the HTML build tool
```

## Versions

The plugin version matches the spec version (now 1.0.0). Each release bumps both, and the spec's Changelog says what changed.

## Contributing

Issues and pull requests are welcome. When you change the rules in `SPEC.md`, also update its Changelog, check that `SKILL.md` still points to the right sections, and bump `version` in `plugin.json`.

To try your changes locally before pushing:

```
claude plugin validate .
claude plugin marketplace add ./
claude plugin install code-schematic@code-schematic-tools
```

## License

[Apache License 2.0](LICENSE)
