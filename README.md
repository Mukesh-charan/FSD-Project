# CA Office Workflow Management System

An enterprise-grade, cloud-native office workflow and compliance management platform built specifically for Indian Chartered Accountant (CA) practices.

Designed for **SMK & Associates**, the system coordinates inward client engagements, automated GST/ITR compliance filings, staff workload balancing, facial biometric attendance, Google Drive OAuth 2.0 cloud storage, and natural-language workflow operations with client-facing sandboxing.

---

## Key Modules & Capabilities

- **Workflow & Task Management**: Full inward ledger tracking client tasks with distinct **Task IDs** (`#10001+`) and **Client IDs** (`#1001+`). Pipeline: `Pending` &rarr; `In Progress` &rarr; `Pending Review` &rarr; `Approved` &rarr; `Filed`, with file attachments, rework tracking, and client deletion safeguards.
- **Client Portal & Data Sandboxing**: Dedicated authenticated portal for clients (`role: 'client'`) allowing self-service task tracking, task creation with file attachments, and direct document downloads without exposure to other clients' data or internal firm operations.
- **Google Drive OAuth 2.0 Cloud Vault (`/api/files`, `/api/drive`)**: User-authorized Google Drive API v3 integration with automated folder hierarchy management (`<ClientID>_<Name>/FY 2024-25/1_Received_from_Client`, `3_Filed_Returns`, `01_KYC`). Uses OAuth refresh tokens to bypass Google service account storage quota limits.
- **Modular AI Office Assistant (`/api/chat`)**: Multi-turn conversational interface powered by a dual-engine architecture:
  - **Client Chat Engine** (`lib/chat/clientChat.js`): Natural-language task creation with proactive document attachment prompts, status queries, and deletion confirmation.
  - **Staff AI Engine** (`lib/chat/groqChat.js`): Tool-calling LLM via Groq API (`llama-3.3-70b-versatile`) for natural-language task allocation, status progression, client creation, and attendance queries.
  - **Deterministic Pattern Fallback** (`lib/chat/patternChat.js`): 100% regex-free token/string pattern matcher for reliable offline operations.
- **Automated Compliance Pipeline (`/api/automate`)**: 1-click recurring filing engine that scans active GST clients and auto-generates compliance tasks (`GSTR-1`, `GSTR-3B`, `GSTR-4`, `CMP-08`) mapped to designated operators.
- **Smart Staff Allocation (`/api/recommend`)**: Workload-balancing engine calculating candidate match scores based on historical category specialization (GST, ITR, Audit) and current queue volumes.
- **Biometric Attendance Tracking (`biometrics.js`, `/api/attendance`)**: Client-side facial recognition powered by `face-api.js` (128D Euclidean descriptor comparison) with geolocation verification and On-Duty (OD) logging.
- **Unified Serverless Architecture (`api/index.js`)**: Dynamic route dispatcher routing all backend modules through a single serverless endpoint to maintain Vercel compatibility.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla HTML5, CSS3, Modern JavaScript (ES6+ Single-Page App) |
| **Backend** | Node.js Serverless Functions (Vercel) & Standalone Server ([`server.js`](file:///c:/Users/mukes/Downloads/Workflow-Management-sanjjey-2/Workflow-Management-sanjjey-2/server.js)) |
| **Database** | MongoDB Atlas Cloud Database (`ca_office_workflow`) |
| **Authentication** | JWT (JSON Web Tokens), `bcryptjs` password hashing, RBAC |
| **Cloud Storage** | Google Drive API v3 via Google OAuth 2.0 Web Client (`googleapis`) |
| **AI / LLM** | Groq API (`llama-3.3-70b-versatile` tool calling) + Deterministic Token Engine |
| **Biometrics** | `face-api.js` (TensorFlow.js) with 68-point facial landmark models |

---

## Project Structure

```
.
├── api/                            # Serverless Backend Gateway
│   ├── index.js                    # Dynamic Serverless Router
│   └── _routes/                    # Modular API Route Handlers
│       ├── attendance.js           # Clock-in/out, biometric verification, OD status
│       ├── audit.js                # System security audit trail (Partner-only)
│       ├── auth.js                 # JWT verification, RBAC check, and audit logger helpers
│       ├── automate.js             # Automated recurring statutory task generation
│       ├── chat.js                 # Lightweight chatbot dispatcher (115 lines)
│       ├── clients.js              # Client master directory CRUD & seeding
│       ├── db.js                   # MongoDB Atlas connection manager singleton
│       ├── drive.js                # Partner-only Google Drive OAuth health check
│       ├── engagements.js          # Standard CA service categories master list
│       ├── files.js                # Google Drive file upload and streaming download
│       ├── init.js                 # First-run database initialization & admin seeding
│       ├── login.js                # User authentication & JWT issuance (Staff & Clients)
│       ├── recommend.js            # Workload-balancing staff recommendation engine
│       ├── tasks.js                # Task workflow ledger, attachments & client isolation
│       └── users.js                # User management (Partner, Staff, Article, Client)
├── lib/                            # Domain Libraries & Microservices
│   ├── driveClient.js              # Shared Google Drive OAuth 2.0 client singleton
│   ├── docs.js                     # Document taxonomy, FY/AY parsing (0 regex)
│   ├── docChat.js                  # Document search & upload classification flow
│   └── chat/                       # Chat Subsystem Microservices
│       ├── chatHelpers.js          # IST dates, atomic ID generation, fuzzy search
│       ├── clientChat.js           # Sandboxed client chat with file attachment chips
│       ├── staffActions.js         # Explicit staff actions (create_task, advance_status)
│       ├── groqChat.js             # Groq LLM tool-calling conversational engine
│       └── patternChat.js          # Zero-regex deterministic pattern fallback engine
├── docs/                           # Documentation & Architecture Guides
│   ├── SYSTEM_ARCHITECTURE_DEMO_GUIDE.md # Full architecture, file dictionary & demo script
│   └── GOOGLE_DRIVE_INTEGRATION.md # Google Drive OAuth integration specifications
├── scripts/                        # Administrative & Maintenance Utilities
│   ├── get_refresh_token.js        # Google OAuth 2.0 refresh token generator
│   ├── seed_client_users.js        # Batch client portal user credentials seeder
│   ├── seed_sample_drive_docs.js   # Sample PDF documents seeder for Drive demo
│   ├── sync_drive_to_mongo.js      # Drive folder metadata synchronizer
│   └── test_drive_connection.js    # Drive OAuth upload/readback/delete verification
├── tests/                          # Automated Test Suites (25 passing tests)
│   ├── client_workflow.test.js     # 16 tests: Client seeding, isolation, chat, security
│   ├── task_attachments.test.js    # 4 tests: Task attachments, upload prompt chips
│   ├── staff_chat_actions.test.js  # 5 tests: Staff chat actions & pattern engine
│   └── drive_e2e.test.js           # Full Drive OAuth hierarchy, queries & downloads
├── models/                         # Pretrained neural net weights for face-api.js
├── app.js                          # Frontend SPA controller & DOM manager
├── biometrics.js                   # Webcam capture & facial descriptor matching
├── styles.css                      # Application styles (WCAG AA compliant, responsive)
├── index.html                      # Single-page application shell
├── server.js                       # Local Express server for offline execution
├── vercel.json                     # Vercel serverless routing rewrite rules
├── package.json                    # Dependencies & npm scripts
└── README.md                       # Main documentation
```

---

## Roles & Access Control Matrix

| Capability | Partner | Staff | Article | Client |
|---|:---:|:---:|:---:|:---:|
| View Entire Office Task Ledger | &check; | Own tasks only | Own tasks only | Own tasks only |
| Create / Allocate Staff Tasks | &check; | &check; | &check; | &cross; |
| Create Own Tasks (with Files) | &check; | &check; | &check; | &check; |
| Submit Tasks for Review | &check; | &check; | &check; | &cross; |
| Approve / File Tasks | &check; | &cross; | &cross; | &cross; |
| Delete Own Active Tasks | &check; | &check; | &check; | &check; (Active only) |
| Manage Clients Master | &check; | &check; | &check; | &cross; |
| Manage User Accounts | &check; | &cross; | &cross; | &cross; |
| View Security Audit Logs | &check; | &cross; | &cross; | &cross; |
| Access Full Google Drive Vault | &check; | &check; | &check; | Own files only |
| Upload to Working / Filed Folders | &check; | &check; | &check; | &cross; (Received/KYC only) |
| Batch Compliance Auto-Dispatch | &check; | &cross; | &cross; | &cross; |

---

## Environment Configuration

Configure the following environment variables in `.env` (locally) or in your Vercel Project Settings:

```env
# MongoDB Atlas
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/ca_office_workflow?retryWrites=true&w=majority

# JWT Authentication
JWT_SECRET=your_jwt_secret_key_here

# Local Development Server Port (Default: 3000)
PORT=3000

# Google Drive OAuth 2.0 (User Quota Integration)
GOOGLE_OAUTH_CLIENT_ID=your_oauth_client_id.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=your_oauth_client_secret
GOOGLE_OAUTH_REFRESH_TOKEN=your_oauth_refresh_token
GOOGLE_DRIVE_FOLDER_ID=1uQnyR7B6v0cNAZ4GzaqErktO0AgcQqju

# Optional: Groq LLM for Natural Language Tool Calling
GROQ_API_KEY=gsk_your_groq_api_key_here
```

A template is provided in [`.env.example`](file:///c:/Users/mukes/Downloads/Workflow-Management-sanjjey-2/Workflow-Management-sanjjey-2/.env.example).

---

## Running Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
# Or directly:
node server.js
```
The application will be accessible at `http://localhost:3000`.

### 3. Initialize the Database
On a new database, trigger first-time initialization to seed default engagements and the partner account:
```bash
curl http://localhost:3000/api/init
# Or open http://localhost:3000/api/init in a browser
```

**Default Initial Accounts:**
- **Partner**: `smk` / Password: `1234`
- **Seeded Clients**: Client ID `1001` (Username: `client_1001` / Password: `1234`)

---

## Automated Testing

Execute the comprehensive test suite covering all 25 unit, integration, and E2E tests:

```bash
npm test
```

This runs:
1. `tests/client_workflow.test.js`: Client seeding, JWT injection, task isolation, and recommendation endpoints (16 tests).
2. `tests/task_attachments.test.js`: Task attachments array, chat upload prompts, and classification (4 tests).
3. `tests/staff_chat_actions.test.js`: Staff natural language actions and regex-free pattern engine (5 tests).
4. `tests/drive_e2e.test.js`: Google Drive OAuth folder generation, file queries, downloads, and audit logs.

---

## Further Documentation

- **[System Architecture & Demonstration Guide](file:///c:/Users/mukes/Downloads/Workflow-Management-sanjjey-2/Workflow-Management-sanjjey-2/docs/SYSTEM_ARCHITECTURE_DEMO_GUIDE.md)**: Detailed file-by-file function dictionary, Mermaid sequence diagrams, and step-by-step presentation script.
- **[Google Drive OAuth Integration Guide](file:///c:/Users/mukes/Downloads/Workflow-Management-sanjjey-2/Workflow-Management-sanjjey-2/docs/GOOGLE_DRIVE_INTEGRATION.md)**: Technical breakdown of Google Drive OAuth 2.0 configuration, scopes, and token exchange.
