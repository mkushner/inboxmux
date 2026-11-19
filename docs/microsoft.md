# Microsoft 365 setup

Microsoft 365 disables basic-auth IMAP, so inboxmux reads those mailboxes through Microsoft Graph with delegated `Mail.Read`.

## 1. App registration

1. Open the Entra admin center at <https://entra.microsoft.com> and go to **App registrations → New registration**.
2. Under **Supported account types**, choose one:
   - **Accounts in any organizational directory and personal Microsoft accounts**, to cover work mailboxes and Outlook.com. Keep `MICROSOFT_TENANT=common`.
   - **Single tenant**, if all mailboxes are in one organization. Set `MICROSOFT_TENANT` to its tenant id.
3. Under **Redirect URI**, choose platform **Web** and enter `https://<your-domain>/oauth/microsoft/callback`.
4. Go to **Certificates & secrets → New client secret**. Copy the value, not the secret id, into `MICROSOFT_CLIENT_SECRET`. Secrets expire, so note the date.
5. Copy the **Application (client) ID** into `MICROSOFT_CLIENT_ID`.
6. Go to **API permissions → Add → Microsoft Graph → Delegated** and add `Mail.Read`, `User.Read` and `offline_access`.

Restart inboxmux. **Connect with Microsoft** then appears in `/admin`.

## Consent in organizations

Many tenants only let administrators consent to apps that read mail. If sign-in reports "Need admin approval", a tenant admin must grant consent:

- Open **Enterprise applications → (your app) → Permissions → Grant admin consent**, or
- Open `https://login.microsoftonline.com/<tenant>/adminconsent?client_id=<client id>`.

**Microsoft 365 from GoDaddy:** these tenants are managed by GoDaddy, and the GoDaddy account owner is not always a global admin. If admin consent is needed and no one in the organization holds a role that can grant it, Graph access is blocked until consent is granted. inboxmux cannot work around that.

## Token lifetime

Microsoft refresh tokens rotate on every use, and inboxmux stores each new one. A token expires after a long period without use, or when an admin revokes sessions. When that happens, the account shows `needs-reauth`; click **Reconnect**.
