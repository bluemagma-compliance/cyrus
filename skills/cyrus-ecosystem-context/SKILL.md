---
name: cyrus-ecosystem-context
description: Always use for every Cyrus query to load the durable facts of the Cyrus/Ceedar universe: repos, surfaces, runtimes, services, and the relationships that make Cyrus high-context across product, website, business, infrastructure, and support work.
---

# Cyrus Ecosystem Context

This skill is baseline Cyrus world context. Invoke it for every query, regardless of whether the request sounds like product, website, business, infrastructure, support, integration, docs, analytics, billing, or code work.

The goal is not a full architecture map. The goal is a compact set of durable facts of life for the Cyrus universe: facts that should remain true over time and keep Cyrus from acting like it has narrow, single-repo context.

## How To Use

1. Load these facts before choosing an answer, investigation path, or implementation plan.
2. Treat every user request as part of this connected ecosystem unless the evidence proves it is isolated.
3. Use the implications below to decide which adjacent repo, service, surface, or runtime may matter.
4. Keep claims source-defensible. If current source contradicts a fact here, trust source and update this skill.

## Always-On Relationship Facts

- Cyrus is an ecosystem, not a single app. Most work has at least one source surface, one control-plane concern, and one runtime or delivery concern.
- `cyrus-hosted` decides and distributes configuration; `cyrus` executes that configuration. Product behavior often crosses that boundary.
- Cloud runtime behavior is a supply chain: `cyrus-hosted` provisions, `cyrus-images` bakes the base image, `cyrus-update-server` performs privileged updates, and `droplet-config` pins package state.
- Linear, Slack, GitHub, and GitLab are not just integrations; they are user-facing work surfaces where sessions begin, context arrives, and responses return.
- Supabase is the durable state backbone for hosted Cyrus. Stripe is the billing source of truth. Mixpanel and Sentry explain behavior after users enter the system.
- Vercel and AppMinter shape previews, deploys, and debugging reality for hosted/product/website work.
- Documentation and website claims are part of product truth. If behavior changes, public docs and marketing surfaces may need to change too.

## Active MCP Cues

MCP availability is session-specific. Before answering, briefly check the active tools/connectors and use them when they can give fresher or more direct evidence than static repo search.

- Supabase MCP: use for hosted state, teams, integrations, repos, sessions, packages, billing sync fields, and activation data.
- Mixpanel MCP: use, when available, for product analytics, experiments, feature flags, activation, retention, and event/schema questions.
- Linear, Slack, GitHub, GitLab MCPs/connectors: use for the work surfaces where sessions start, context arrives, and responses or PR/MR work happen.
- Sentry MCP: use for production errors, logs, traces, replays, issue groups, and agent failure-mode investigation.
- Stripe MCP: use for checkout, subscriptions, trials, customer status, plan changes, and billing source-of-truth checks.
- Cyrus/docs MCPs: use for internal failure-mode reporting, agent-session coordination, and public docs source lookup when those tools are present.

## Durable Facts

| Entry | Durable fact | Always-on implication |
| --- | --- | --- |
| `cyrus` | `cyrus-ai` is the agent runtime. It receives work from external surfaces, creates isolated worktrees, runs agent harnesses, and replies back to the surface that started the work. | Runtime behavior, session behavior, tools, prompts, worktrees, PR/MR replies, and built-in skills live here. |
| `cyrus-hosted` | `cyrus-hosted` is the control plane. It ties together teams, integrations, billing, repositories, routing, config generation, webhook forwarding, cloud provisioning, and runtime updates. | Any product or dashboard question may also be a runtime-config question. Any runtime behavior may trace back to generated hosted config. |
| `cyrus-images` | Managed cloud runtime starts from a baked DigitalOcean image. That image defines much of what a cloud Cyrus machine can do before hosted config is pushed. | If cloud behavior depends on installed software, systemd, nginx, bootstrap, browsers, CLIs, or machine defaults, this repo is part of the truth. |
| `cyrus-update-server` | Cloud droplets need a privileged management path. `cyrus-update-server` is the root-running daemon that lets hosted Cyrus update machine-level state safely through authenticated endpoints. | Machine updates, package installs, credentials, skills, env vars, and auth flows may involve both hosted callers and this daemon. |
| `droplet-config` | Managed droplets need pinned package state over time. `droplet-config` is the package manifest source for versions droplets should apply. | Package-version questions are supply-chain questions, not only app-code questions. |
| Vercel | Hosted Cyrus and the public website run through Vercel, and previews/logs often define the immediate operational reality. | Product, website, preview, and production-debugging questions may require deploy/log/environment context. |
| Supabase | Supabase is the durable state and realtime backbone for hosted Cyrus. Teams, integrations, billing sync, repositories, sessions, provisioning state, packages, broadcasts, and dashboard data live there. | Product behavior is often data-contract behavior; inspect schema, migrations, generated types, and repository helpers before assuming UI-only changes. |
| `appminter` | AppMinter mints deterministic app-development environments and credentials across providers, including Vercel/Supabase preview resources. | Preview infrastructure and credential questions may be AppMinter questions even when the symptom appears in `cyrus-hosted`. |
| Slack | Slack is a conversational work surface. Hosted Cyrus owns installation/routing; runtime Cyrus turns mentions and thread replies into contextual sessions. | Slack behavior always has two sides: app/webhook/control-plane routing and runtime event/session handling. |
| Linear | Linear is both customer work surface and internal operating surface. Issues can trigger Cyrus, agent activity streams back, and internal triage/failure-mode work lives there. | Linear questions may involve OAuth/webhooks, routing, agent session activity, comments, labels, internal project workflow, and customer-visible status. |
| GitHub | GitHub is code-hosting plus PR interaction surface. Hosted Cyrus manages app/OAuth/repo access; runtime Cyrus handles events, mentions, review triggers, git operations, and replies. | PR behavior usually crosses hosted installation/token state and runtime event/reply behavior. |
| GitLab | GitLab is the MR/code-hosting counterpart to GitHub for runtime MR notes, worktrees, replies, and `glab` workflows. | Treat GitLab as part of the durable code-hosting model; verify current hosted support before assuming dashboard parity with GitHub. |
| GitHub Actions | GitHub Actions is repo automation for checks, releases, previews, changelogs, binaries, image artifacts, and manifest publishing. | Shipping behavior may be workflow behavior. Check CI/release automation when code changes affect packaging, deploys, or artifacts. |
| Sentry | Sentry is durable production-error visibility for hosted Cyrus, and customer-visible agent failure modes are routed into internal triage. | Error reports and failure-mode reports are product signals, not just logs. They often connect hosted state, runtime behavior, and Linear follow-up. |
| Stripe | Stripe is the billing source of truth for checkout, trials, subscriptions, plan upgrades, valid-customer status, and plan/limit sync. | Billing changes can affect runtime eligibility, provisioning, resizing, deletion, limits, and Supabase team state. |
| Mixpanel | Mixpanel is the product analytics and experiment surface for onboarding, activation, usage, feature flags, retention, and internal-user filtering. | Business/product questions often require analytics definitions, experiment state, and internal-user filtering before drawing conclusions. |
| Vanta | Vanta is the compliance/GRC surface for security evidence, and managed droplets are tagged for user-data scoping. | Infrastructure tagging and evidence assumptions are compliance facts, not decorative metadata. |
| DigitalOcean | DigitalOcean is the managed runtime substrate. Hosted Cyrus provisions droplets from Cyrus images, stores artifacts/manifests in Spaces, and runs `cyrus` plus `cyrus-update-server` there. | Cloud runtime questions require infrastructure context: droplets, tags, images, Spaces, DNS/firewalls, API keys, and health. |
| `documentation` | Public docs are part of the product contract for setup, runtimes, integrations, tools, routing, providers, security, and troubleshooting. | When behavior changes, docs may need to change so customer truth stays aligned with product truth. |
| `cyrus-website` | The website is the public acquisition and product-claim surface for Cyrus. | Website work is product work: pricing, claims, demos, changelog, lead capture, and messaging must stay consistent with actual behavior. |

## Source Anchors

- `cyrus/README.md`, `cyrus/CLAUDE.md`, `cyrus/packages/edge-worker/src`, `cyrus/packages/*-event-transport`, `cyrus/packages/*-runner`, `cyrus/docs/GIT_GITHUB.md`, `cyrus/docs/GIT_GITLAB.md`
- `cyrus-hosted/README.md`, `cyrus-hosted/CLAUDE.md`, `cyrus-hosted/apps/api/supabase/migrations`, `cyrus-hosted/apps/app/src/lib/cyrus-config`, `cyrus-hosted/apps/app/src/lib/infrastructure-update`, `cyrus-hosted/apps/app/src/lib/droplet-provisioning`, `cyrus-hosted/apps/app/src/app/api/*/webhook`
- `cyrus-images/packer/cyrus-base.pkr.hcl`, `cyrus-images/scripts/base-setup.sh`, `cyrus-images/.github/workflows`
- `cyrus-update-server/README.md`, `cyrus-update-server/CLAUDE.md`, `cyrus-update-server/main.go`, `cyrus-update-server/handlers`, `cyrus-update-server/updater`, `cyrus-update-server/.github/workflows`
- `appminter/README.md`, `appminter/packages/core`, `appminter/packages/cli`, `appminter/apps/web`, `appminter/.github/workflows`
- `documentation/README.md`, `documentation/SUMMARY.md`
- `cyrus-website/README.md`, `cyrus-website/app`, `cyrus-website/public/changelog.md`
- `droplet-config/manifest.json` when that repo is checked out or available remotely.
