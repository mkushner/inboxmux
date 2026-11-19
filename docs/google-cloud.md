# Google Cloud setup

inboxmux uses one Google OAuth client for two things:

- **Owner sign-in:** scopes `openid email`.
- **Gmail accounts:** scope `https://www.googleapis.com/auth/gmail.readonly`.

## 1. Project and Gmail API

1. Create a project at <https://console.cloud.google.com>, or reuse one.
2. Go to **APIs & Services → Library**, find **Gmail API** and click **Enable**.

## 2. Consent screen

Open **Google Auth Platform → Branding / Audience**.

### Audience

- **Internal:** possible only when the project belongs to a Google Workspace organization. It works only for accounts in that organization, needs no verification, and its refresh tokens do not expire on a schedule. Choose this if every mailbox you connect is in one Workspace domain.
- **External:** needed for personal `@gmail.com` accounts or for several organizations. `gmail.readonly` is a *restricted* scope, so check the publishing status:
  - **Testing:** only listed test users can sign in, and refresh tokens expire after **7 days**. Each Gmail account then needs **Reconnect** in `/admin` every week. Use Testing only to try things out.
  - **In production, unverified:** fine for personal use. Google shows an "unverified app" warning; continue with **Advanced → Go to …**. Unverified apps are capped at 100 users. Refresh tokens no longer expire after 7 days, though Google still revokes them after long inactivity or a password change.
  - **Verified:** full verification of a restricted scope requires a security assessment. It is only worth it if you run inboxmux for other people.

After you change the publishing status, reconnect existing Gmail accounts so they get refresh tokens under the new rules.

### Data access

Add the scope `.../auth/gmail.readonly`. For sign-in, `openid` and `.../auth/userinfo.email` are non-sensitive and need no review.

## 3. OAuth client

1. Go to **Clients → Create client → Web application**.
2. Add the authorized redirect URI `https://<your-domain>/oauth/google/callback`.
3. Copy the client id and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 4. Google Workspace notes

Admins can block third-party apps. If connecting a Workspace mailbox fails with "access blocked", a Workspace admin must allow the app:

1. In the Admin console, open **Security → Access and data control → API controls → Manage third-party app access**.
2. Add the OAuth client id and mark it **Trusted**. **Limited** may also work, depending on policy.

Without the Google Cloud project: for a personal Gmail account you can skip this whole guide and add the account as IMAP with the **Gmail via IMAP** preset and an app password (<https://myaccount.google.com/apppasswords>, needs 2-Step Verification). You still need the OAuth client for owner sign-in. Sign-in only needs `openid email` and uses no refresh tokens, so Testing mode is enough for it.
