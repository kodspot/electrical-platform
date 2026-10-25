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
- **Photos show in the asset, failure and inspection details.** Photos attached to an asset, a
  failure report or an inspection now appear when you press *View*; they showed as broken
  images before.
- **Proof photos stay for 30 days from when they were taken.** A proof photo for work finished
  on an older ticket is no longer removed the next night.
- **Supervisors' ID details are better protected.** Aadhaar numbers and blood groups of
  supervisors are now protected the same way as electricians'. Change history records that
  they changed, not the numbers themselves.

## For residents and guests
- **You can see the photo of the fix.** The review page that asks whether the problem is
  fixed now shows the photo the electrician took. It showed a broken image before.

## For everyone who signs in
- **Password and PIN reset links are better protected.** If you requested a reset link shortly
  before this update and it no longer works, request a new one.
- **Names show in full.** Names containing quotation marks or apostrophes, such as
  *O'Brien Hostel*, now show correctly in tooltips and buttons.

## Security and privacy improvements (no action needed)
- The electrician app no longer receives residents' contact details.
- Administrators' pages are protected against harmful text entered as a name.
- Running alert checks by hand affects only your own organization.
