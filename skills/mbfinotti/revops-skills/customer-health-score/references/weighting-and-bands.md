# Weighting, Normalization, Decay, Bands

## Deriving weights from outcomes

1. Pull the churned and retained/expanded cohorts over the trailing 12-24 months (or as far as data exists).
2. For each candidate signal, compare its behavior in the two cohorts over the prediction window. Keep signals with a real separation; weight proportionally to separation strength.
3. The working rule: if one signal separates churned from retained several times more strongly than another, equal weights make the score deliberately wrong. Weights are an empirical claim, not a design preference.
4. Normalize each kept signal to a common 0-100 scale with defined thresholds, then compute the composite as the weighted sum. Weights total 100.
5. Anti-pattern - the performative score: overweighting whatever is easy to measure (logins) and underweighting what is predictive but hard (champion presence, adoption depth). The 40/25/20/15-style splits circulating in vendor examples are illustrative starting hypotheses at best; every published source that offers one also says weighting is unique to each company.

## Caps and the champion rule

- Cap every category's share so no single input can move an account across a band alone. Convergence of two moderate signals should outweigh one strong one.
- Require at least one stakeholder-continuity input with enough downside weight to pull the band down by itself. This is the one deliberate asymmetry in the model: nothing may hold green after a champion departs, but no single positive signal may force green either.

## Decay

Every engagement-type signal drifts toward neutral as it ages. A score that never drifts accumulates false-positive greens: healthy six months ago, silent for weeks, still reading green.

Two implementations. efficiency: rolling windows > per-signal half-lives. Value runs the same way for a first score, so one line covers both axes.

- **Rolling windows.** Near-zero effort: one date filter per signal, computed wherever the score already runs, and a CSM can restate the rule in a sentence. Buys most of the decay benefit outright - green creep stops. A trailing 30-day window is a common practitioner default - a convention, not a researched constant; match the window to the book's sales/usage rhythm.
- **Per-signal half-lives.** An hour to fit, then a standing job: each half-life is a claim about that signal's shelf life that has to be re-checked at every recalibration. Buys smoother movement and a truer read where shelf lives genuinely differ - a sponsor meeting ages nothing like a login. Costs legibility: a CSM cannot reconstruct a decayed score by hand, and the trust that costs is not always bought back by the accuracy.
- Promote half-lives when window boundaries are themselves causing band flapping, or when one category's shelf life is obviously out of scale with the rest.
- Decay toward neutral, not toward red: silence is uncertainty, not confirmed risk. Let the trend component carry the alarm.
- Fit/firmographic-type inputs don't decay; only behavioral ones do.

## Trend and level, both

- Score movement is where the insight lives: a falling 75 is a worse account than a stable 60. Carry a trend component (delta over 1-2 periods) alongside the level, and display the score with a trend arrow and top risk driver.
- Guard against single-point noise: one bad month on one metric is noise more often than trend. Require two consecutive readings (or a trailing average) before a band change fires.

## Bands

- Three bands. Four or five sound precise and add confusion; if the team can't instantly decide what to do with a score, the bands aren't working.
- Size the red band to intervention capacity first, statistics second: if the team can work 30 accounts a month, a red band flagging 200 is a list nobody works. Then improve the model until the same capacity catches more of the actual churn.
- Every band has a wired play, an owner, and an SLA. A band with no play should not exist.
  - Top band: expansion/advocacy motion.
  - Middle: structured value intervention within a stated SLA.
  - Red: escalation with leadership review.
- B2B renewal proximity is a dimension of the score, not a filter after it: the same signals weigh heavier inside the renewal window, and a red account near renewal outranks a red account mid-contract for attention.

## Segment calibration (mandatory)

- One global model over unlike segments produces false negatives by construction: a 70 healthy for a mature enterprise account is a red flag for an SMB still onboarding. Low-touch segments run naturally lower engagement - shift weight from engagement to sentiment/support-responsiveness there.
- Override per segment: weights, thresholds, and expected signal ranges. Segment at minimum by size/touch model and by lifecycle stage (onboarding vs mature).
- Keep the segment count as small as the differences justify - each segment needs its own validation cohort.

## One score or two (expansion)

efficiency: one composite with a gating top band > a second dedicated expansion model.

- **One composite, three bands, top band gates expansion plays.** Near-zero marginal effort - it is the score already being built and validated, so it costs one model, one validation loop, and one number the field learns to read. The dominant practitioner pattern; a healthy top band is an expansion signal, not a rest state.
- **A second, dedicated expansion model.** A quarter to build and a standing job to keep: expansion-specific inputs (whitespace mapping, multi-team adoption spread, plan-limit trajectories) must be systematically tracked, and someone must maintain two validation loops instead of one. Buys better signal - the composite predicts churn and is a blunt proxy for growth.
- Promote it once those inputs are already tracked and the account base is large enough to validate a second model against its own outcomes. Below that it is a second unvalidated score, which is worse than none.
- No ranking on expected expansion lift, deliberately: no rigorous published study shows high health causally predicting expansion - only vendor case studies. Any ratio quoted for expansion payoff would be invented precision. Promise a better-qualified expansion queue, never expansion lift.
- The more common legitimate split is by lifecycle stage or segment - not by risk-vs-expansion outcome.

Health is necessary but not sufficient: the top band earns the expansion conversation. Qualify it on non-health conditions:

- Whitespace (unowned seats/products/teams).
- Fit.
- Plan-limit pressure: accounts pushing plan limits with strong engagement are the classic usage-derived expansion trigger.
- Budget and contract timing.
