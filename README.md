# Class Social Network — Setup Guide

A live interactive demo for the Week 9 group activity. Classmates select their name, choose who they've talked to, and a D3.js force-directed graph of the class network appears in real time.

**Stack:** Static HTML/CSS/JS (GitHub Pages) + Google Sheets (database) + Google Apps Script (API)

---

## Quick Architecture

```
Classmate's phone/laptop
        │
        ▼
  GitHub Pages site          Google Sheets
  ┌──────────────┐     ┌─────────────────────┐
  │  index.html  │────▶│  ClassList (tab)     │  ← reads names
  │  app.js      │     │  col A: Name         │
  │  style.css   │     ├─────────────────────┤
  │              │────▶│  Responses (tab)     │  ← reads edges
  │              │     │  Source | Target      │
  └──────┬───────┘     └──────────▲──────────┘
         │                        │
         │   POST (submit)        │
         ▼                        │
  Google Apps Script ─────────────┘
  (web app that writes to the Responses sheet)
```

---

## Step-by-Step Setup

### 1. Create the Google Sheet

1. Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet.
2. Rename it to something like `COR2249 Class Network`.
3. Rename the first tab/sheet to **`ClassList`**.
4. In column A, add a header `Name` in row 1, then list all student names starting from row 2:

   | A |
   |---|
   | Name |
   | Alice Tan |
   | Bob Lim |
   | Charlie Ng |
   | ... |

5. **Share the sheet**: Click "Share" → change access to **"Anyone with the link"** → set to **"Viewer"**. This lets the website read the class list without authentication.

6. Copy the **Sheet ID** from the URL. It's the long string between `/d/` and `/edit`:
   ```
   https://docs.google.com/spreadsheets/d/1aBcDeFgHiJkLmNoPqRsTuVwXyZ/edit
                                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                          This is your SHEET_ID
   ```

### 2. Set Up the Google Apps Script (backend)

This is what receives form submissions and writes them to the sheet.

1. In your Google Sheet, go to **Extensions → Apps Script**.
2. Delete the default `Code.gs` content.
3. Copy and paste the entire contents of `google-apps-script.js` from this folder.
4. Click **Deploy → New deployment**.
5. Click the gear icon next to "Select type" and choose **Web app**.
6. Set:
   - **Description**: `Class Network API`
   - **Execute as**: `Me (your email)`
   - **Who has access**: `Anyone`
7. Click **Deploy**.
8. **Authorize** the app when prompted (it needs permission to edit your sheet).
9. Copy the **Web app URL** — it looks like:
   ```
   https://script.google.com/macros/s/AKfycbx.../exec
   ```

> **Note:** Every time you change the Apps Script code, you need to create a **new deployment** (Deploy → New deployment) for the changes to take effect. The URL changes with each new deployment.

### 3. Configure the Website

Open `app.js` and update the `CONFIG` object at the top:

```javascript
const CONFIG = {
  SHEET_ID: '1aBcDeFgHiJkLmNoPqRsTuVwXyZ',           // ← your Sheet ID
  CLASS_LIST_SHEET: 'ClassList',                        // ← tab name with names
  RESPONSES_SHEET: 'Responses',                         // ← tab name for responses
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycbx.../exec',  // ← your Apps Script URL
};
```

### 4. Test Locally

Just open `index.html` in a browser. No server needed — it's all static files + fetch calls.

- You should see the class list load from your Google Sheet
- Select a name, pick connections, submit
- The graph should appear with your data

### 5. Deploy to GitHub Pages

1. Create a new GitHub repo (e.g., `class-network`).
2. Push the contents of this `presentation` folder to the repo:
   ```
   git init
   git add .
   git commit -m "Class social network demo"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/class-network.git
   git push -u origin main
   ```
3. Go to the repo on GitHub → **Settings → Pages**.
4. Set Source to **"Deploy from a branch"**, branch = `main`, folder = `/ (root)`.
5. Wait ~1 minute. Your site will be live at:
   ```
   https://YOUR_USERNAME.github.io/class-network/
   ```
6. Share this URL or generate a QR code for class.

---

## How It Works in Class

### Before class
- Make sure the Google Sheet has the class list in the `ClassList` tab
- The `Responses` tab can be empty (it gets created automatically by the script)
- Test the full flow once yourself

### During the presentation

1. **Show QR code / link** — everyone opens the site on their phone
2. **Step 1** — each person selects their name (names already submitted show a ✓)
3. **Step 2** — each person taps everyone they've talked to this term
4. **Submit** — data goes to Google Sheets via Apps Script
5. **Graph appears** — the D3.js force-directed network renders live
6. **Discuss** — point out:
   - Who is the most connected node?
   - Are there visible clusters (e.g., by project group)?
   - Who bridges different groups?
   - Who is isolated?
   - **Then pivot to Moretti**: "This is exactly what Moretti does with Hamlet. But what did our graph NOT capture?"

### After class
- Hit the **↻ Refresh data** button to pull the latest submissions
- The graph updates as more people submit

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Class list doesn't load | Make sure the Google Sheet is shared as "Anyone with the link → Viewer" |
| Submit doesn't work | Check that the Apps Script URL is correct in `CONFIG` and that the deployment is set to "Anyone" |
| Responses sheet is empty after submitting | The Apps Script might not be authorized — open it in Apps Script editor and run `doPost` manually once to trigger the auth prompt |
| Graph shows no edges | Make sure the `Responses` tab has headers `Source` and `Target` in row 1 |
| CORS errors in console | Normal for `no-cors` mode — submissions still go through. If in doubt, check the Responses sheet directly |

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Main page — 4-step flow |
| `style.css` | Dark-themed, presentation-friendly styles |
| `app.js` | All logic: Google Sheets integration, form flow, D3.js graph |
| `google-apps-script.js` | Paste this into Google Apps Script (not used by the website directly) |
| `README.md` | This file |
