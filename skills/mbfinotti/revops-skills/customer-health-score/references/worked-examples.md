# Worked Examples

Illustrative specs with invented-but-realistic numbers. Every weight and threshold below must be re-derived from the user's own outcome data - copying these values verbatim recreates the performative-score failure this skill exists to prevent.

## Example 1: CSM-covered B2B (renewal-anchored)

```
HEALTH SCORE SPEC - Meridian Analytics (B2B data platform), 2026-03-10, v2
Outcome      : non-renewal at contract anniversary | account level | churn within 120 days
Segments     : Enterprise (CSM 1:15) | Mid-market (CSM 1:60) - separate weights and thresholds
Signals      : usage/adoption 35% - per-seat weekly active rate + core-capability breadth, trend
                 over 2 periods | evidence: declined in 11 of 14 churned accounts by day -90
               relationship 30% - exec-sponsor meeting recency, champion activity, stakeholder
                 breadth | evidence: 9 of 14 churned accounts lost sponsor contact by day -120
               support 15% - severity-weighted ticket trend per 100 seats, resolution-time trend
                 | evidence: escalation clusters preceded 6 of 14 churns
               commercial 10% - payment-timeliness drift, contraction requests | evidence: weak
                 separation; kept for the invoice-dispute tripwire
               sentiment 10% - survey trend + structured CSM rating (green requires exec-buyer
                 meeting < 60 days + >= 3 weekly-active users) | provisional - low response rate
Decay        : engagement/relationship inputs on trailing 30-day windows, drift to neutral;
               firmographics static
Rollup       : per-user rates weighted by role - champion 3x, admin 2x, end-user 1x; breadth
               floor: engagement concentrated in 1 user caps the relationship component at 60
Bands        : Green >= 70 | Yellow 45-69 | Red < 45 (mid-market: 65/40 - lower-touch norm)
               Red -> save play, CSM + manager, 5 business days; Yellow -> value review, 14 days;
               Green -> expansion review at next sync
Expansion    : Green for 2+ consecutive months AND (seat utilization > 80% OR new-team usage
               spread) -> expansion-qualified queue; AE qualifies on whitespace + budget
Overrides    : CSM one-click with reason code (sponsor-change | data-gap | context | other);
               clusters reviewed quarterly
Validation   : FY25 cohort, scored at day -90: red band churned 4.1x base rate; 71% of churned
               accounts below green at day -90; 62% of book green. Miss post-mortems: 4 green
               churns, all champion-departure cases -> v2 added the continuity input
Triggers     : band drop -> CRM task + owner alert; red inside 120-day renewal window -> weekly
               leadership review
Governance   : logic: RevOps manager | data: analytics eng | acting: CSM team | quarterly
               recalibration | change log in the RevOps runbook
```

## Example 2: PLG / B2C subscription (continuous)

```
HEALTH SCORE SPEC - Loopnote (prosumer note app, $9-19/mo self-serve), 2026-02-01, v1
Outcome      : cancellation or no reactivation within 30 days of expiry | subscriber level |
               churn within 60 days
Segments     : Individual | Team (2-10 seats, team plan gets a breadth component)
Signals      : usage recency/frequency 45% - RFM-style: days since last session, sessions/week
                 trend | evidence: recency decay preceded 78% of cancellations in H2 cohort
               depth 25% - core-action count per session, feature breadth | evidence: shallow
                 usage churned 2.9x deeper usage
               billing 20% - payment-failure events, dunning outcome, downgrade clicks |
                 evidence: soft-decline subscribers churned at 3.5x base
               engagement 10% - support/community/education touchpoints | provisional
Decay        : all behavioral inputs on trailing 21-day windows (fast product rhythm)
Rollup       : none for individuals; team plan adds seat-breadth (active seats / paid seats)
Bands        : Green >= 65 | Yellow 40-64 | Red < 40 - continuous evaluation, no renewal anchor;
               Red -> automated win-back sequence + dunning retry logic; Yellow -> lifecycle
               nudge (re-activation email, feature education); Green -> upgrade/annual-plan offer
Expansion    : Green + hitting plan limits (storage/seats) -> upgrade prompt; no human motion
Overrides    : none (no CSM layer); support agents can flag mis-scored subscribers, flags
               reviewed monthly as label data
Validation   : H2 cohort: red churned 3.8x base; 69% of churned subscribers below green at
               day -45 (60-90-day check compressed to the shorter lifecycle); 58% green
Triggers     : band drop -> lifecycle-automation event; payment failure -> immediate red review
Governance   : logic: growth PM | data: product analytics | monthly recalibration (volume
               supports it) | change log in the growth repo
```

## Example 3: a plausible-looking broken score, decomposed

The model: `health = logins 40% + NPS 20% + tickets 20% (more tickets = worse) + CSM gut rating 20%`, five bands, no decay, one global model. It looks reasonable and fails on every axis this skill checks:

- **Logins 40%, raw count**: big accounts read permanently green, small ones permanently sick; no trend, so a 50% decline from a high base stays green. Fix: per-seat rate, trend-scored, capped.
- **No relationship/continuity input**: a champion departure changes nothing until logins finally sag months later - the exact silent-churn miss. Fix: stakeholder-continuity input with band-down power.
- **Tickets scored as "more = worse"**: the most engaged accounts get punished; the disengaged account filing nothing reads healthy. Fix: rate-normalized trend, zero-ticket disengagement check.
- **CSM gut rating, unstructured**: relationship warmth overrides risk ("great call three weeks ago" holds green through an open escalation); ratings aren't comparable across CSMs. Fix: structured rating definitions plus gated overrides instead of a free-form input.
- **No decay**: every green accumulates; the book creeps toward >80% green and the score stops moving. Fix: drift-to-neutral windows.
- **Five bands, no plays**: nobody can say what band 2 vs band 3 means for action, so nobody acts. Fix: three bands, each wired to a play with owner and SLA.
- **Never backtested**: weights came from a workshop, not from churned-vs-retained separation - a performative score. Fix: run the backtest, re-derive, and hold it to the pass floor before trusting it.
