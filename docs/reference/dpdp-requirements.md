# DPDP Requirements Register

How the platform stands against the Digital Personal Data Protection Act, 2023 and the
Rules of 2025. Status as of 2026-11-06.

**This is an engineering assessment, not legal advice.** Sections of the Act were read from
the published text (PRS India). The Rules could not be read directly: the Gazette PDF on
meity.gov.in refuses automated download, so every Rule below comes from a Press Information
Bureau summary and law-firm commentary (Ikigai Law, SCC Online, TeamLease, India Briefing).
Have counsel confirm against the Gazette (G.S.R. 846(E)).

## Timing

Commentary reports that the Rules were notified on 13 or 14 November 2025, with most duties
starting eighteen months later: about **13 to 14 May 2027**. Reports of a proposal to shorten
that period could not be confirmed. Re-check before relying on the date.

## Register

| Requirement | Source | Status | Where |
|---|---|---|---|
| Notice before collecting | s.5, Rule 3 | **Partly.** The notice exists and is linked at the consent box. It must stand alone and itemize data and purposes: counsel to review | `public/privacy.html`, `public/scan.html` |
| Notice in English or an Eighth Schedule language | s.5(3) | **Gap.** English only. Languages were out of scope for this pass: owner decision | AUD-11/05 |
| Consent is free, specific, and limited to what is needed | s.6 | **Met for residents:** asked only when a name or phone is given, and refused by the server without it | `routes/public.js` (BUG-0060) |
| Withdrawing consent as easily as giving it | s.6(4) | **Partly.** By email only | AUD-11/06 |
| Staff processed without consent, for employment | s.7(i) | **Likely the right basis, but the notice says something else:** that an admin "consents on behalf of" staff. Counsel to reword | AUD-11/03 |
| Who is the Data Fiduciary | s.2(i), 2(k), s.8(1) | **Open.** Kodspot is probably a Processor for each organization. That decides who owes these duties, and needs a contract | AUD-11/01 |
| Reasonable security safeguards | s.8(5), Rule 6 | **Largely met:** encryption of sensitive fields, access control, audit log, hashed credentials, TLS. Contact details are not encrypted at field level | AUD-11/10 |
| Access logs kept one year | Rule 6 (commentary) | **Not verified.** The audit log is kept. Retention of server logs depends on the host | AUD-11/11 |
| Breach: tell the people affected and the Board | s.8(6), Rule 7 | **Procedure now written;** not exercised | [`RUNBOOKS.md`](../RUNBOOKS.md) |
| Erase when the purpose is over | s.8(7), Rule 8 | **Partly:** photos 30 days, resident details 180 days. A one-year minimum retention reported in Rule 8 may conflict with both: counsel to resolve | AUD-11/12 |
| Grievance contact published | s.8(10), s.13, Rule 14 | **Met,** with a named contact. Response in 30 days, within the reported 90-day limit | `public/privacy.html` |
| Children: verifiable parental consent, no tracking | s.9, Rule 10 | **Gap, and the most serious one.** Hostel residents can be under 18, and the notice says the service is not for them | AUD-11/04 |
| Rights to access, correct, erase, and to nominate | ss.11–14 | **Partly.** Access is self-service for all staff (BUG-0076), and an admin can erase one resident (BUG-0081). Nomination is not offered | AUD-11/06 |
| Transfers outside India | s.16 | **Permitted unless restricted.** AI providers and email may be abroad: owner to confirm regions | Inventory |
| Significant Data Fiduciary duties | s.10 | **Not expected at this scale.** Depends on government notification | None |

## Aadhaar

The Aadhaar field is a separate question from DPDP, because the Aadhaar Act limits who may
collect or use the number. The field is optional, encrypted for electricians, and not needed
by any feature. The migration that encrypts existing staff values has not been run in
production. See AUD-11/02.
