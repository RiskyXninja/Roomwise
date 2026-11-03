# Roomwise rental management

Responsive single-admin rental billing app for desktop browsers and Android. The server uses Node.js built-ins and SQLite; no third-party packages are required.

## Run from VS Code

1. Open this project folder in VS Code.
2. Install Node.js 22.13 or newer if it is not already installed.
3. Open **Terminal → Run Task → Roomwise: start app** (or run `npm start` in the integrated terminal).
4. Open the `http://127.0.0.1:<port>` address printed in the terminal (normally `http://127.0.0.1:3000`). If that port is occupied, the app tries the next available port.
5. On first launch, create the admin password. Choose a unique password with at least 12 characters and keep it safe.

The task is also available from the Run and Debug panel as a server launch configuration. Roomwise binds to `127.0.0.1` by default and stores its SQLite database in the ignored `data/` directory.

## Using the app

Add rooms and their fixed rent and electricity rate, then add tenants to occupied rooms. Create calendar-month bills from each room's meter readings. The bill retains its original rent and rate. Payments are allocated to oldest balances first, with overpayments kept as tenant credits. Tenant history stays attached to old bills after move-out. Meter photos can be captured from a phone; OCR is only attempted where the browser exposes the experimental `TextDetector` API, so always verify the reading.

Download a JSON backup from Reports. Restore it there to replace the current data. Download a formatted `.xlsx` report. Invoices can be printed or saved as PDF from the browser print dialog. Change the admin password from the settings button; existing sessions are then signed out.

## Android and deployment

For phone use, deploy the Node server on a machine or hosting service that the phone can reach. Put it behind HTTPS before exposing it beyond the computer. Set `NODE_ENV=production` behind a TLS reverse proxy so session cookies are marked Secure. The server defaults to loopback; set `HOST=0.0.0.0` only when you have configured the network firewall and HTTPS access. The app does not use a static-only host because billing data and admin sessions are handled by the server.

Keep the downloaded JSON export somewhere outside the server machine. For a raw SQLite file copy, stop the server first so the database and its write-ahead log stay consistent. The server does not currently run scheduled off-device backups or cloud synchronization.

## Manual acceptance checklist

- Add two rooms with different rates, then assign a tenant to each.
- Create a bill and check that rent, units × rate, prior balance, adjustment, and total are correct.
- Enter a lower current reading and confirm the bill is rejected.
- Record multiple partial payments and confirm the outstanding balance changes each time.
- Pay more than the balance and confirm the extra shows as tenant credit.
- Generate a later bill with an open balance and check that the balance is carried once.
- Move out a tenant, add a replacement, and confirm the old profile and bills remain.
- Download and restore a JSON backup; print an invoice to PDF.
