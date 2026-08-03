# 🚀 Saheli Dresses WhatsApp Bot — Local Windows Deployment Guide

This guide explains how to package, deploy, and run the WhatsApp Bot locally on an always-on **Windows PC** (instead of a VPS), using two flexible methods:

1. **Windows Service** (*Primary / Production*) — Set & forget option that starts automatically when Windows boots, runs in the background without any open terminal, and auto-restarts if it crashes.
2. **Portable `.exe`** (*Secondary / Quick Demo*) — Single executable file to double-click and launch for testing or demos.

---

## 🛠️ Method 1: Windows Service (Recommended for Production)

### Prerequisites:
- Node.js (v18+) installed on the PC.
- Open **Command Prompt** or **PowerShell** as **Administrator** (Right-click → *Run as administrator*).

### Step 1: Install the Windows Service
Run the following command in the project directory:

```bash
npm run service:install
```

- This registers `SaheliDressesWABot` in Windows Services.
- The bot will start immediately in the background and will automatically launch every time the PC boots up.

### Step 2: Verify Service Status
To check if the service is running:
1. Press `Win + R`, type `services.msc`, and press Enter.
2. Look for **SaheliDressesWABot**.
3. Open your browser and visit: `http://localhost:8080` (or your configured `PORT`).

### Service Logs & Troubleshooting
Because the service runs in the background without a terminal:
- Log files are saved automatically in the `daemon/` directory inside the project folder (`daemon/sahelidresseswabot.out.log` and `daemon/sahelidresseswabot.err.log`).
- If something goes wrong, inspect `daemon/` log files.

### Step 3: Updating Code
When you pull new code updates or make changes:
```bash
# 1. Open Elevated Terminal (Run as Admin)
npm run service:uninstall

# 2. Pull or update your code
git pull origin main

# 3. Reinstall and restart service
npm run service:install
```

### Step 4: Uninstall the Service
If you ever want to completely remove the Windows Service:
```bash
npm run service:uninstall
```

---

## 📦 Method 2: Portable `.exe` (For Testing & Demos)

The Portable `.exe` bundles Node.js and the application logic into a single double-clickable executable.

### Step 1: Build the `.exe`
Run:
```bash
npm run build:exe
```
This produces `dist/SaheliWABot.exe`.

### Step 2: Running the Executable
- Double-click `dist/SaheliWABot.exe` (or run it via terminal).
- A console window will open displaying startup logs.
- Open your browser to `http://localhost:8080` to access the dashboard.

### Important Executable Notes:
- **Keep Terminal Open**: Closing the console window terminates the bot.
- **Environment File**: Ensure a `.env` file exists in the same directory as `SaheliWABot.exe` if custom environment variables (like `PORT` or `SUPABASE_URL`) are required.
- **Browser Binary**: The executable relies on system Chromium / Chrome. On first run, ensure Chromium is installed or present in system PATH / Puppeteer cache.

---

## ⚡ Critical Power Settings Requirement for Local PCs

Unlike a VPS, a standard Windows PC has default power-saving settings that put the machine to sleep after inactivity. When the PC sleeps, background services pause.

### MANDATORY CONFIGURATION:
1. Open **Windows Settings** (`Win + I`).
2. Navigate to **System** → **Power & battery** (or **Power & Sleep**).
3. Under **Screen and sleep**:
   - Set **"When plugged in, put my device to sleep after"** → **Never**.
4. Disable **Hibernate** to ensure 24/7 continuous bot uptime.

---

## 💾 WhatsApp Session Persistence

The WhatsApp authentication session is stored locally on disk in the `session-data/` directory.
- **Do NOT delete `session-data/`** when updating or restarting the service.
- As long as `session-data/` remains intact, you will **not** need to re-scan the QR code when the service or PC restarts.
