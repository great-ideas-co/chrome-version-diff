# Chrome Version Testing

This project installs Chrome for Testing builds into the repo and launches them with isolated profiles. The goal is to make Chrome version testing reproducible and easy to reset.

## Why This Exists

Most visual testing tools solve a different problem than this one.

- Paid visual platforms are usually built around baseline management, hosted reviews, and CI workflows. They are strong for ongoing product regression testing, but heavier than needed when you just need to answer: "which Chrome version started breaking this page?"
- Playwright snapshot assertions are great when you already own the test suite and want to compare today's render against a previously approved screenshot. They are less focused on quickly walking a live site across many Chrome versions to find the first broken build.
- This tool is aimed at browser-version triage first: install exact Chrome for Testing builds locally, point them at a real URL, focus on a specific part of the page, and capture evidence per version in one run.

That makes it useful for niche debugging cases such as:

- a WordPress site where a plugin or theme started misbehaving in one Chrome milestone
- a third-party embed, payment form, or consent banner that only fails in certain browser versions
- a "broken in production" page where you do not have an existing automated test suite, but still need repeatable browser-version evidence
- ad hoc regression analysis before you decide whether a full Playwright or SaaS visual testing setup is justified

The point is not to replace full regression platforms. The point is to give you a lightweight workflow for approaching an unknown or already-broken site, narrowing the failure to a browser version, and then optionally turning that investigation into automated snapshot checks.

## Local State

These directories are created locally and are safe to delete:

- `chrome/`: Chrome for Testing builds installed through `@puppeteer/browsers`
- `.runtime/`: Temporary profiles used for launch diagnostics

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Clear any local browser/profile state from previous runs:

   ```bash
   npm run chrome:clear
   ```

3. Install the Chrome versions you want to test:

   ```bash
   npm run chrome:install -- --versions 143,latest
   ```

## Usage

Launch versions side by side with Puppeteer:

```bash
npm run chrome:launch -- --url https://example.com --versions 143,latest
```

Take snapshots after a render delay and save one PNG per browser version into a single folder:

```bash
npm run chrome:snapshot -- --versions 143,latest --url https://example.com
```

Target a section of the page with XPath, wait for rendering, and use a wider viewport plus a zoomed-out capture:

```bash
npm run chrome:launch -- --headless --snapshot \
  --versions 143,latest \
  --url https://example.com \
  --xpath '//*[@id="content"]/div/div/section[4]/div/div/div/div[3]' \
  --render-delay-ms 3000 \
  --viewport-width 1600 \
  --viewport-height 1400 \
  --zoom 0.85
```

Run a direct headless diagnostic without Puppeteer:

```bash
npm run chrome:launch -- --versions 143 --direct-only --headless
```

List locally installed builds:

```bash
npm run chrome:list
```

## Notes

- `--versions` accepts a comma-separated list such as `143,latest`.
- GUI launches stay open until you press `Ctrl+C`.
- Headless launches close automatically unless you pass `--keep-open`.
- The launcher verifies each browser binary with `--version` before using Puppeteer.
- Snapshots default to `.runtime/snapshots/<timestamp>/` unless you pass `--snapshot-dir`.
- Snapshot files are named with both the requested version label and the resolved Chrome build.
- `--xpath` automatically enables snapshot mode, scrolls the viewport to the target first, then `--render-delay-ms` waits before capture.
- `--viewport-width`, `--viewport-height`, `--zoom`, and `--device-scale-factor` let you tune the render view.
