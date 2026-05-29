# Vision: dunning

## 1. The problem

Subscription startups lose revenue to failed card charges they never follow up on. They want an app that, when a charge fails, automatically emails and texts the customer with a link to update their card, and stops once payment succeeds.

## 2. Users

- **Billing operator** — connects the company's payment provider, watches a dashboard of at-risk subscriptions, and tunes the reminder cadence.
- **Customer (recipient)** — receives the email/SMS and follows the link to fix their payment. Not an account holder in this app.

## 3. Must-haves

- [ ] An operator signs in and connects the company's Stripe account so failed-charge events flow in.
- [ ] On a failed charge, send the customer a reminder email (Postmark) and SMS (Twilio) with a secure update link.
- [ ] When a later charge for that customer succeeds, stop the reminder sequence and mark it resolved.

## 4. Nice-to-haves

- [ ] Configurable reminder cadence per plan tier.

## 5. Non-goals

- This app will NOT store raw card numbers — it only references Stripe customer/charge IDs.
- No in-app payment collection; the update link goes to Stripe's hosted page.

## 6. Constraints

- **Budget**: pay-as-you-go on Stripe/Twilio/Postmark; no other paid services.

## 7. Tech preferences

(Pinned stack — no preferences.)

## 8. Success metric

After connecting a Stripe test account and simulating a failed charge, the customer receives both an email and an SMS containing an update link; simulating a subsequent successful charge stops further reminders and marks the sequence resolved in the operator dashboard.

## 9. Escalation budget

- **Max session cost before pausing**: $25
- **Tasks may fail at most**: 2 times before escalating.

## 10. Anything else

Stripe, Twilio, and Postmark are all required integrations; their credentials are provisioned by the operator.
