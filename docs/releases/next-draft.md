# Release notes — next release (DRAFT, not tagged)

> **Draft.** These notes cover the customer-visible changes since v1.0.0. They come from the
> fixes that followed the 2026-10 product and architecture review (BUG-0027 onwards). Per
> Charter §18 they use the words each audience would recognise, and security fixes describe
> the improvement, not the mechanics. Publish them with the next tagged release.

## For administrators
- **Deactivating a supervisor hands over their open tickets.** Each open ticket goes to the
  other supervisor covering its location. If no one else covers it, the ticket goes back to
  the shared list. The new assignee is notified, and the message after deactivating says how
  many tickets moved. Before, the tickets stayed with the deactivated supervisor, where other
  supervisors could not see them.
- **Deleting an electrician explains why it can't.** An electrician who appears on a duty
  roster, in attendance records or on tickets they fixed is kept, with that reason shown. This
  is the same rule as for inspection history. Before, the delete failed with an error, or
  removed their attendance history.
- **Analytics and the dashboard show inspection activity.** The electrician and supervisor
  bars in *Analytics* show how many inspections each person did; they read "undefined"
  before. The dashboard's *Today's Inspection Log* now lists today's inspections instead of
  always saying none were logged.
- **Alert rules can notify the people at the location.** An alert rule, and its escalation,
  can now notify the supervisors and electricians who cover the location concerned. Editing
  a rule no longer removes those choices. Tickets that an alert rule creates now go to the
  supervisor covering the location, who is notified. Before, nobody held them.
- **Missed-inspection alerts come at the right time.** An alert for a missed night
  inspection now arrives after the night shift, not minutes after it starts, and a round
  done before midnight counts. A room that misses two rounds in a day gets an alert for each.
  Every alert rule you set up now fires; before, only the first rule on the same event did.
- **Actions that cannot be done say why.** If deleting an alert rule, acknowledging an alert
  or flagging an inspection is refused (for example because someone just removed it), the
  page now says so instead of doing nothing.
- **Date filters cover the whole day.** Choosing a day, or a range of days, in tickets,
  alerts, the audit log, inspections, assets and analytics now includes everything from
  midnight. Before, anything between midnight and 5:30 in the morning was counted under the
  day before. *Today* is also correct just after midnight. The charts in *Analytics* and the
  room heatmap count each inspection on the day it was done; the report's days are no
  longer shifted by one.
- **Attendance is for today or yesterday, and only in the past.** Supervisors can no longer
  mark attendance for a future date. Just after midnight, the dashboard's attendance shows
  the new day.
- **The audit log shows more.** It now records sign-ins, password and PIN changes, changes
  to inspection templates and duty rosters, attendance corrections, alert-rule edits,
  acknowledged alerts, and tickets raised by staff, each with who did it.
- **A purchase cost of 0 is kept.** Assets that cost nothing, such as donations, keep 0 as
  their cost instead of showing it as unknown.
- **Photos show in the asset, failure and inspection details.** Photos attached to an asset, a
  failure report or an inspection now appear when you press *View*; they showed as broken
  images before.
- **Proof photos stay for 30 days from when they were taken.** A proof photo for work finished
  on an older ticket is no longer removed the next night.
- **Supervisors' ID details are better protected.** Aadhaar numbers and blood groups of
  supervisors are now protected the same way as electricians'. Change history records that
  they changed, not the numbers themselves.

## For electricians
- **Tickets under a deactivated floor open.** If an administrator deactivates a floor or a
  block but keeps the rooms in it, you can now open the complaints from those rooms that you
  are notified about. Before, the app said the ticket was not found.
- **Your profile says Electrician.** It said Admin before.

## For residents and guests
- **You can see the photo of the fix.** The review page that asks whether the problem is
  fixed now shows the photo the electrician took. It showed a broken image before.

## For everyone who signs in
- **"Forgot password?" and "Forgot PIN?"** The sign-in pages now let you ask for a reset link
  by email. Electricians receive it at the email address their administrator has on file. If
  no email arrives, your administrator can still set a new password or PIN for you.
- **Change your password or PIN yourself.** Open your name at the top right, then *Profile*,
  then *Change password* (or *Change PIN*). You stay signed in on this device, and any other
  device that is signed in to your account is signed out.
- **Password and PIN reset links are better protected.** If you requested a reset link shortly
  before this update and it no longer works, request a new one.
- **A shared phone keeps each person's work apart.** If a supervisor and an administrator
  are both signed in on one phone, an inspection the supervisor saved without signal is now
  sent in as the supervisor's. Before, it could be recorded as the administrator's.
- **Names show in full.** Names containing quotation marks or apostrophes, such as
  *O'Brien Hostel*, now show correctly in tooltips and buttons.

## Security and privacy improvements (no action needed)
- The electrician app no longer receives residents' contact details.
- Administrators' pages are protected against harmful text entered as a name.
- Running alert checks by hand affects only your own organization.
- A guest's name is removed from the change history after 180 days, as it already was from
  the complaint itself.
