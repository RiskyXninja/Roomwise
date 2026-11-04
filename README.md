# Roomwise rental management

Responsive single-admin rental billing app for desktop browsers and Android. Local development uses Node.js built-ins and SQLite. The free cloud deployment uses Neon Postgres through a small `pg` connection pool.

## Run from VS Code

1. Open this project folder in VS Code.
2. Install Node.js 22.13 or newer if it is not already installed.
3. Open **Terminal → Run Task → Roomwise: start app** (or run `npm start` in the integrated terminal).
4. Open the `http://127.0.0.1:<port>` address printed in the terminal (normally `http://127.0.0.1:3000`). If that port is occupied, the app tries the next available port.
5. On first launch, create the admin password. Choose a unique password with at least 12 characters and keep it safe.

The task is also available from the Run and Debug panel as a server launch configuration. Roomwise binds to `127.0.0.1` by default and stores its SQLite database in the ignored `data/` directory.

## Using the app

Add rooms and their fixed rent and electricity rate, then add tenants to occupied rooms. Create calendar-month bills from each room's meter readings. The bill retains its original rent and rate. Payments are allocated to oldest balances first, with overpayments kept as tenant credits. Tenant history stays attached to old bills after move-out. Meter images are OCR-scanned on the device and discarded; only the corrected reading and bill calculation are saved. Always verify a suggested OCR reading.

Download or restore a JSON backup from Settings. Download a formatted `.xlsx` report. Invoices can be printed or saved as PDF from the browser print dialog. Change the admin password from the settings button; existing sessions are then signed out.

After calculating a bill, use **Share on WhatsApp** to open a prefilled message addressed to the tenant's saved contact number.

## Android APK

The Android app packages the responsive Roomwise interface and connects securely to the same Neon-backed Render service as the web app. It needs an internet connection to sign in and sync records. Build a debug APK on Windows with Android Studio, Android SDK, and Java 21 installed:

```powershell
npm install
npm run android:apk
```

The installable APK is created at `android/app/build/outputs/apk/debug/app-debug.apk`. Copy it to an Android phone and open it to install. Camera meter images are processed on-device and are not included in saved bills or backups. If the Render service URL changes, update `nativeApiBase` in `index.html` and rebuild.

## Free cloud deployment

1. Create a Neon Postgres project on its Free plan and copy the pooled connection string from the project’s **Connect** panel. Keep this URL private; never commit it to GitHub.
2. Push the app files, including `server-neon.mjs` and `render.yaml`, to the GitHub `main` branch.
3. In Render, choose **New → Blueprint**, connect the repository, and apply the Blueprint. Render prompts for `DATABASE_URL`; paste the Neon connection string there.
4. Once deployment succeeds, open its `onrender.com` URL and create the admin password.

The Blueprint uses Render’s free web-service plan and runs `server-neon.mjs`. It applies the versioned SQL migration in `migrations/` once, then initializes the app state. Render serves the app over HTTPS; its free web service sleeps after 15 minutes without traffic, so the first visit after idle can take about a minute. Neon Free scales database compute to zero when idle; its database storage remains separate from the Render service filesystem.

Before moving from the local SQLite app, download a JSON backup from Reports. After the deployed app starts, create its admin password and restore that JSON backup from Settings. The cloud app and local app use separate databases until you restore the backup. Keep a copy of the JSON backup somewhere safe; neither free service provides a substitute for a regular independent backup.

The SQLite local mode remains available through `npm start`. To run the Neon mode locally, install dependencies and set `DATABASE_URL`, then run `npm run start:cloud`.

## Manual acceptance checklist

- Add two rooms with different rates, then assign a tenant to each.
- Create a bill and check that rent, units × rate, prior balance, adjustment, and total are correct.
- Enter a lower current reading and confirm the bill is rejected.
- Record multiple partial payments and confirm the outstanding balance changes each time.
- Pay more than the balance and confirm the extra shows as tenant credit.
- Generate a later bill with an open balance and check that the balance is carried once.
- Move out a tenant, add a replacement, and confirm the old profile and bills remain.
- Download and restore a JSON backup; print an invoice to PDF.
