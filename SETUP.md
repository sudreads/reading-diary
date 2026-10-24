# Reading Diary - setup

The app works on its own straight away (saved on the phone). These steps put it online and
connect the Google Drive backup. About 25 minutes, once.

## 1. Put it online (GitHub Pages)

1. Make a GitHub account at github.com (free). Pick the username carefully - it becomes the
   app's address: `https://<username>.github.io/reading-diary/`. **That address must never
   change**, because the phone keeps the diary under it.
2. Tell Claude the username. Claude creates the `reading-diary` repository and pushes the code
   (Claude will ask before pushing).
3. In the repository: Settings → Pages → Source: "Deploy from a branch" → `main` / root → Save.
   After a minute the app is live at the address above.

The code is public. Your diary is not - it only lives on your phone and in your Drive.

## 2. Connect Google Drive (Google Cloud, free)

Do this signed in as your **SUN** Google account (the SUN profile in Chrome).

1. Go to console.cloud.google.com → create a project called `Reading Diary`.
2. APIs & Services → Library → search **Google Drive API** → Enable.
3. APIs & Services → OAuth consent screen (Google Auth Platform):
   - User type: **External**. App name `Reading Diary`, your email as support + developer contact.
   - Data access / Scopes: add `.../auth/drive.appdata`, `openid`, `.../auth/userinfo.email`.
   - Audience / Test users: add your **SUN** Gmail address. Leave the app in **Testing**.
4. APIs & Services → Credentials → Create credentials → **OAuth client ID** →
   Application type **Web application**. Authorized JavaScript origins:
   - `http://localhost:8790`
   - `https://<username>.github.io`
   No redirect URIs needed.
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`) and give it to Claude. It goes
   into `js/config.js`. A client ID is not a secret - it's fine that it's in public code.

Because the app stays in Testing, Google shows an "unverified app" warning the first time -
tap Continue. Google may ask you to approve it again every so often; the status pill at the top
turns amber, and one tap fixes it.

## 3. Install it on your phone

1. Open the address in **Chrome** on your Android phone.
2. Menu (⋮) → **Add to Home screen** → Install.
3. Open it from the home screen → Settings → **Connect Google Drive** → pick your SUN account → tap "Yes, use this account" once.
4. The pill should turn green: "Saved to Drive · just now".

## 4. Reminders

In the app: Settings → Reminders. It walks you through MacroDroid (free) so your phone says
"Time to read 📖" when you get home on your Wi-Fi.

## If something goes wrong

- Pill amber "changes not backed up": tap it, it signs in and saves.
- New or reset phone: install the app, connect Drive, and everything comes back.
- Settings → Download backup gives you a file copy any time.
