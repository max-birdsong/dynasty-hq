# Dynasty HQ

A personal dynasty fantasy football dashboard for the Sleeper user `boximax`. It's a static site with no login and no build step, designed to be hosted on GitHub Pages.

## What it does

- **Dashboard:** every league in one table: record, playoff and title odds, lineup rank, FantasyCalc rank, Sanderson rank, and a plan (Push / Contend + sell age / Middle / Sell / Tank). It also shows a week-by-week odds grid, sell candidates and holds across all your rosters, and any offers still waiting on a reply.
- **Simulator:** a Monte Carlo of the rest of each season, built from Sleeper's weekly projections scored with each league's own settings (TEP included). It uses the real schedule, the median game where a league has one, and a playoff bracket.
- **Power rankings:** every team's FantasyCalc and Sanderson totals (players plus picks), projected starters now and in the playoffs, playoff and title odds, core age, and whether they're contending or rebuilding.
- **FantasyCalc values** are pulled automatically for each league's format (team count, superflex/1QB, PPR).
- **TAT upload:** drop in the weekly Sanderson PDF on the Values page. Tiers become values using each league's FantasyCalc pick values, interpolated within tiers, and risers and fallers since the last upload are listed.
- **Owner profiles:** each manager's trade history this season and last, pick capital vs the default, picks gained and sent in trades, positions and ages they buy and sell, positional needs and strengths, the offers you've sent them, and private notes. The same person is linked across all your leagues.
- **Trade calculator:** FantasyCalc totals with the 2-for-1 adjustment, Sanderson gain, both lineups before and after (now and in the playoff weeks), a starting-QB check, partner-fit rules, and a button to re-simulate both teams' playoff and title odds.
- **Trade suggestions:** a search across every league using your rules:
  - the partner comes out ahead on FantasyCalc, and rebuilders win clearly
  - contenders don't lose points or their starting QB
  - rebuilders only receive players under 28
  - old RBs only go to contenders
  - your lineup is protected in leagues where you're contending
  - targets (★) get priority, and untouchables (🔒) are never offered
  - offers that were already rejected are skipped
- **Trade log:** use "Log as sent" on any offer. Each time you open the log, it checks Sleeper and marks offers accepted automatically when the trade goes through. Rejected, countered, ignored and withdrawn are set by hand.
- **History:** odds, FantasyCalc, Sanderson and lineup strength are recorded every week you open the site. A GitHub Action also saves a weekly snapshot, so FantasyCalc totals and records keep building even in weeks you don't open it.

## Setup (about 10 minutes)

1. Create a new **public** GitHub repo, for example `dynasty-hq`. GitHub Pages on a free account requires a public repo.
2. Upload everything in this folder to the repo, including the hidden `.github` folder and `.nojekyll`. The easiest way is `git push`, or drag the files into the GitHub web uploader.
3. Go to the repo's **Settings → Pages**. Under Source, choose "Deploy from a branch", then branch `main` and folder `/ (root)`. The site appears at `https://<you>.github.io/dynasty-hq/` within a minute or two.
4. Go to the **Actions** tab, enable workflows if GitHub asks, open "Weekly snapshot" and click **Run workflow** once. After that it runs every Tuesday.
5. Open the site, go to **Values** and upload the latest TAT PDF.

### Sync laptop and phone

Your trade log, TAT uploads, owner notes, settings and weekly history are saved to `data/state.json` on a separate `data` branch of this repo. The website code stays on `main`, so saving data never redeploys the site.

1. Create a fine-grained token: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**. Give it access to **only this repo**, with **Contents: Read and write**.
2. On the laptop, open the site's **Settings**, paste the token and press **Connect**.
3. Press **Copy link for my phone** and open that link on your phone once. The phone is then connected too.

How it works after that:

- Every change is saved within a few seconds.
- Each device pulls the latest data when you open the site, switch back to the tab, come back online, and every 3 minutes while it's open.
- If both devices change something at the same time, the two versions are merged rather than overwritten. Deleted entries stay deleted on both devices.
- If you're offline, the header shows "Offline, will retry" and your changes are saved when you reconnect.
- The token stays on each device and is never written to the repo.

Because the repo is public, anyone with the link can read `data/state.json`, which includes your trade log.

## Notes

- **Projections:** Sleeper's weekly projections come from an undocumented endpoint. If it's ever blocked, the simulator falls back to each player's season average, and the dashboard says so.
- **FantasyCalc 2-for-1 adjustment:** the formula is `min(value × 0.6982, 753 + 0.23 × value)` for each extra piece. If the FantasyCalc site shows a different adjustment for the same trade, change the three constants in Settings.
- **Thresholds:** contending, rebuilding and the trade rules are all adjustable in Settings. Leagues with a median game count both games, so the win-percentage thresholds still work there.
- **Refresh:** ↻ reloads everything. Otherwise, API data is cached for 20 minutes to 6 hours depending on how often it changes.
