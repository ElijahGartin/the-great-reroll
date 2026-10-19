@AGENTS.md

# Claude worker contract (War Table fork)

This file is **fork-specific** guidance for Claude agents working in [Elijah Gartin's fork](https://github.com/ElijahGartin/the-great-reroll) of [johnnywow/the-great-reroll](https://github.com/johnnywow/the-great-reroll). Keep new sections here additive so upstream merges stay easy.

The workflow below adapts practices from Anthropic's Claude Code team, described in [*How the Claude Code team does code review*](https://claude.dev/blog/solving-code-review-at-anthropic/) (Addy Osmani, Morgan Westlee Lunt, and Qing Wang; published October 15, 2026). That post emphasizes verification before a PR exists, short owner-written `REVIEW.md` context, and **review that converges** (cap rounds, fix whole classes of bugs, re-review only new diffs).

## Before opening a pull request

1. Run **`/code-review`** and **`/security-review`** on the change (local skills or subagent review with fresh context).
2. **Fix** valid findings. For false positives, do not churn the code—note a one-line dismissal in the PR body when the thread would otherwise repeat.
3. **Validate locally**, scoped to what the diff touches:
   - Application or rule changes: `npm run check`, `npm test`, and any area-specific scripts referenced in `README.md` (for example `npm run check:chart` when Helm changes).
   - Platform or deploy contract changes: run the managed-application gate from `AGENTS.md`.
   - **Docs-only PRs:** state that in the PR body and skip unrelated builds (no need to run production qualification or chart renders when only markdown changed).

## `REVIEW.md`

Keep [`REVIEW.md`](./REVIEW.md) short and current: failure modes, high-scrutiny paths, and recurring review themes for this repo.

- When Codex or a human flags the same issue on multiple PRs, **move the rule into `REVIEW.md`** (or a lint/check) instead of re-arguing it every time.
- Reviewers (Codex and humans) should **read and apply `REVIEW.md`** alongside the diff.

## Review rounds (convergence)

Target **about three** substantive review rounds per PR. After ~3 rounds with findings:

- Step back and reconsider the approach.
- Fix the **whole class** of bug, not one line at a time.
- Later re-reviews cover **only commits since the last review**, without repeating findings already posted or dismissed.

## House rules (this fork)

- **Claude opens PRs but never merges.**
- The **DevSecOps Principal** merges after **Codex is clean** and a Principal **ACCEPT** is recorded on the **same HEAD** as the merge.
