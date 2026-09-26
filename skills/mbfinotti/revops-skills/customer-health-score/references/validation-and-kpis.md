# Validation, Cold Start, KPIs, Governance

A composed-but-unvalidated score is the industry's default failure - 73% of CS leaders say theirs doesn't reliably predict churn (ChurnZero 2025 study). Everything here exists to put the user's score in the other 27%.

## Backtest procedure

1. Retro-score accounts as they stood at a fixed point in the past (e.g. 90 days before each renewal or churn event), using only data that existed at that time. Signals backfilled after the outcome are the classic leak.
2. Compare predicted band against actual outcome over the prediction window, per segment.
3. Use precision/recall, never raw accuracy: churn is class-imbalanced, so a model that calls everything green scores high accuracy while predicting nothing.
   - **Precision of red** = share of red accounts that actually churned (wasted-intervention cost when low).
   - **Recall of red** = share of churned accounts the red band caught (missed-churn cost when low).

   Tune the red threshold to the costlier error: recall-leaning for high-value segments, precision-leaning when interventions are expensive. No ranking between the two leanings; which error costs more is a property of the user's book, not of the method, so a default order here would be false precision.

4. Run the retro check: for every account that churned, what did it score 60 and 90 days before? Churned accounts that read green until the end mark the model's blind spot - identify which category would have caught them and reweight.
5. Sanity-check the distribution: more than ~80% of the book sitting green is a documented practitioner red flag for a broken model, whatever the backtest says.
6. Spot-check a handful of known accounts by hand. Each must land where an experienced CSM would put it, and the champion-departure case must not be green.
   - A recent churn.
   - A recent expansion.
   - A known-shaky renewal.
   - A champion-departure case.

## Pass floor (this skill's convention)

No standards body publishes a numeric ship-it bar for health scores; the floors below are this skill's convention, set where a model becomes worth acting on and trustable by CSMs:

- Red band churns at **>= 3x the portfolio base rate** (precision lens).
- **>= 2/3 of churned accounts** sat below green 60-90 days pre-churn (recall lens).
- **< 80% of the book green** (distribution guard).

Iterate signals, weights, decay, and thresholds until all three hold. If they can't be met with available data, ship a rules-based score labeled as such (below) - never present an unvalidated composite as predictive.

## Cold start: too few churn events

Backtesting needs churned accounts to compare against; young or low-churn books don't have enough.

efficiency: rules-based proxy > statistically fitted score. Value runs the other way - the fitted score is the better model - which is exactly why the ratio, not the value, decides here.

- **Rules-based proxy.** An hour to a week: onboarding-milestone completion, activation/adoption thresholds, recency tripwires (no qualifying activity in N days), champion-contact recency - all readable off data the product already emits, and legible enough that a CSM can argue with a named rule instead of distrusting a black box. Label every weight a hypothesis. Buys a working at-risk list now, and no predictive claim.
- **Statistically fitted score.** A quarter of analyst time plus tens of churn events per segment, then a standing job to re-fit. Buys the better model: weights derived from what churned accounts actually did rather than from what someone expected.
- Promote fitting the moment tens of churn events exist per segment; until then resist tuning to individual anecdotes.
- When the book has no churned-account history at all, drop the fitted option from the menu rather than parking it at the bottom, and say so plainly - a ruled-out option left sitting in the list reappears as scope at the next planning round.

1. Still define the churn event, entity level, and prediction window now - so validation can start the moment events accumulate.
2. Treat the first 2-4 quarters as data collection. Log the score at fixed intervals so future backtests can retro-read it honestly.
3. Interview-validate meanwhile: monthly, ask experienced CSMs which accounts the score got wrong. Several named misses a week means the model is noise - fix the named causes.

## KPIs - is the score working?

| KPI                     | Definition                                                 | Healthy signal                                                                |
| ----------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Red-band churn multiple | Red-band churn rate / portfolio base rate                  | >= 3x, stable across quarters                                                 |
| Missed-churn rate       | Churned accounts that were green 60-90 days out            | Trending toward zero; each miss gets a post-mortem                            |
| Score distribution      | Band shares over time, per segment                         | Stable; green creep = decay or calibration failure                            |
| Play completion         | Band-change alerts that produced the wired play within SLA | High - otherwise it's a dashboard, not a score                                |
| Override rate + reasons | Overrides / accounts, clustered by reason code             | Low and explainable; a repeated reason code is a model bug filed by the field |
| Save/expansion outcomes | Red plays that retained; top-band plays that expanded      | The numbers to report upward - never report score coverage as success         |

## Recalibration cadence

- **Monthly for the first 90 days** after launch or major change: distribution by segment, CSM-named misses, play completion.
- **Quarterly standing.** Faster (monthly) for PLG/B2C - more volume, faster drift.
  - Rerun the backtest on the newest cohort.
  - Re-derive weights where separations shifted.
  - Retire signals that lost predictive power.
- **Off-cycle triggers:**
  - Product or pricing change.
  - ICP/segment shift.
  - Green-creep in the distribution.
  - A cluster of green-account churns.
  - Override rate climbing.

## Governance and overrides

- Diffuse ownership - every team contributes a metric, nobody owns the formula - is the classic decay path.
  - One owner for the logic (CS ops or RevOps).
  - One data owner for the pipeline.
  - CSMs as the acting owners.
- Overrides are a credibility mechanism, not a bug: a CSM who thinks "this is wrong, but whatever" has already downgraded the score to a report. Allow one-click overrides gated by a mandatory reason code; review override clusters at each recalibration as labeled disagreement data.
- Version every change with date, author, reason, and expected effect; announce to the CS team before it lands. Keep the per-account score breakdown visible where CSMs work - an unexplainable score loses the field faster than a wrong one.
