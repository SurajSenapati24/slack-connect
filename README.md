# Slack Connect Scheduler

A full-stack application to connect a Slack workspace, list channels, send messages instantly, or schedule them for future delivery.  
Built with **Vite + React** for the frontend and **Node.js (Express + TypeScript)** for the backend.

---

## 🚀 Features
- **Slack OAuth 2.0** authentication
- **Channel listing** (public & private) from connected Slack workspace
- **Instant messaging** to selected channels
- **Message scheduling** with automatic sending using `node-schedule`
- **Persistent storage** using `lowdb`
- **Frontend** with clean UI built using React & Tailwind CSS
- **Backend** API to handle Slack requests and schedules

---

## 🛠 Tech Stack
**Frontend:**
- React (Vite)
- Tailwind CSS
- Axios

**Backend:**
- Node.js + Express
- TypeScript
- lowdb (JSON storage)
- node-schedule
- dotenv

**Integrations:**
- Slack API (`chat:write`, `channels:read`)

---

## 📂 Project Structure
slack-connect/
│
├── backend/
│ ├── src/server.ts # Main Express server
│ ├── .env # Environment variables
│ ├── db.json # LowDB storage
│ ├── package.json
│ └── tsconfig.json
│
├── frontend/
│ ├── src/ App.jsx # main frontend file
│ ├── public/
│ ├── package.json
│ └── vite.config.js
│
└── README.md


---

## ⚙️ Setup & Installation

### 1️⃣ Clone the Repository
```bash
git clone https://github.com/SurajSenapati24/slack-connect.git
cd slack-connect

cd backend
npm install

PORT=3000
SLACK_CLIENT_ID=your_slack_client_id
SLACK_CLIENT_SECRET=your_slack_client_secret
SLACK_REDIRECT_URI=https://<your-ngrok-url>/auth/slack/callback
ADMIN_SECRET=changeme

npm run dev 

cd ../frontend
npm install


get your ngrok url by 
intalling ngrok in your system and the run the command
ngrok http 3000

export const API_BASE_URL = "https://<your-ngrok-url>";

npm run dev

