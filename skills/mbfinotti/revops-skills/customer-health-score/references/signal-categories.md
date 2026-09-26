# Signal Categories Inside a Composite

Boundary note: this file covers how each category behaves once it is _in_ the score - normalization, trend windows, rollup, traps. Which specific indicators to pick and how predictive each is belongs to `mbfinotti/revops-skills@customer-churn-signals`; take its output as this file's input.

Sections run in the build ranking from SKILL.md § Build order, best value-per-hour first. Re-rank against the user's own data before following it - the order assumes the product emits usage events and that nobody is logging sponsor meetings yet.

## Product usage and adoption

Typically the heaviest-weighted category (40-50% in circulating SaaS examples - illustrative, not a standard; derive the real weight from the book's own outcomes).

- Measure:
  - Breadth: share of core capabilities adopted.
  - Depth: intensity per active user.
  - Recency/frequency: an RFM-style read.
  - Seat utilization: active vs purchased.
- Always rate-normalize: divide activity by user count. Raw counts make big accounts look healthy and small accounts look sick by construction.
- Score the trend, not the level - a 30% decline from a high baseline outranks a stable low baseline as a risk read.
- Trap: usage describes behavior, never intent. An account can show strong usage while evaluating a competitor or absorbing a sponsor change the dashboard can't see. This is why usage can never be the whole score - cap its share.

## Commercial / financial

- Signals: payment timeliness drift (net-30 sliding toward 75 days), contract-value trajectory, discount/renegotiation frequency, invoice disputes.
- This category surfaces risk when usage looks fine: daily logins coexist with disputed invoices and a resigned champion.
- B2C/PLG: include the involuntary-churn layer - failed payments and dunning outcomes belong in the score, since payment failure correlates with engagement decline and is itself an intervention trigger.

## Support

- Ticket volume alone is not a risk signal. Rate-normalize by account size, read it as a trend, and read severity/escalations and resolution-time trend rather than counts.
- An account filing one critical bug a quarter can be healthier than one filing zero tickets - zero can mean disengagement.
- Context-blindness trap: an SLA miss during an outage that hit dozens of accounts is not the same signal as a miss specific to one account.

## Relationship and engagement (champion/sponsor)

The highest-value and hardest-to-automate category.

- Signals: meetings held, executive-sponsor contact recency, responsiveness trend, stakeholder breadth across roles and functions.
- That combination is what puts it fourth on ratio and first on value; build it early anyway wherever renewals hinge on a named buying organization.
- In B2B, weight champion/decision-maker engagement as its own component rather than folding it into aggregate usage - flat aggregate activity hides a champion who stopped logging in while junior users keep running routine tasks ("silent churn").
- Design rule: at least one stakeholder-continuity input must be able to pull the band down on its own; no combination of usage greens may hold an account green after a champion departs.
- Structure CSM sentiment where it feeds the score: define what each rating requires ("cannot be green without an executive-buyer meeting in the last 2 months and regular active users" - the ChurnZero-style definitional approach). Unstructured gut ratings are not comparable across a portfolio.

## Sentiment (survey and qualitative)

- Signals: relationship surveys (NPS-style), post-interaction satisfaction, effort scores, ticket-text tone.
- Sentiment is context for behavior, not a standalone predictor: strong usage with falling sentiment often means the customer uses the product out of necessity while hunting alternatives.
- Read as trend across periods; a single response is noise. Low response rates make this category unstable - weight accordingly.

## Rollup: user-level to account-level (B2B)

- Aggregate as normalized weighted averages (activity per user, not totals), with stakeholder-role weighting: champion and decision-maker signals count more than end-user signals.
- Breadth matters: engagement concentrated in one person is fragile even when the aggregate is high; multiple inactive admins are a signal one inactive user is not.
- B2C and single-user PLG skip rollup entirely - subscriber level is the account level. Everything else in this file applies unchanged.
