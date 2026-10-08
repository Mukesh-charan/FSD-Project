# CA Office Workflow Management System

An end-to-end, cloud-native office workflow and compliance management platform built specifically for Indian Chartered Accountant practices.

Designed for **SMK & Associates**, the system streamlines inward client engagements, automated GST compliance filings, staff workload balancing, facial biometric attendance, and natural-language workflow operations.

---

## Key Modules & Capabilities

- **Workflow & Task Management**: Full inward ledger tracking client tasks with distinct **Task IDs** (`#10001+`) and **Client IDs** (`#1001+`). Status pipeline: `Unassigned` &rarr; `Assigned` &rarr; `Pending Review` &rarr; `Approved` &rarr; `Filed`, including rework loop counts and pending reason tracking.
- **Conversational AI Office Assistant (`/api/chat`)**: Multi-turn chatbot interface allowing staff and partners to create tasks, reassign operators, advance approval stages, check attendance, query stats, and edit records using natural language.
- **Automated Compliance Pipeline (`/api/automate`)**: 1-click recurring filing engine that detects active GST clients and auto-generates compliance tasks (`GSTR 1`, `GSTR 3B`, `GSTR 4`, `CMP 8`) mapped to their designated staff members.
- **Smart Staff Recommendation (`/api/recommend`)**: Algorithmic staff matching score calculated from historical client handling, current queue volume, and live daily attendance status.
- **Client Master & Tax Registry (`/api/clients`)**: Centralized directory managing Indian tax parameters (PAN, Aadhaar, ITR-V credentials, GSTIN, composition scheme flags, and contact details).
- **Biometric Attendance Tracking (`biometrics.js`, `/api/attendance`)**: In-browser client-side facial recognition powered by `face-api.js` (TensorFlow.js) alongside standard clock-in/out, On Duty (OD) marking, and monthly attendance logs.
- **Google Drive Document Vault (`/api/drive`)**: Direct cloud integration with Google Drive via Service Account credentials for secure client file storage and workpaper browsing.
- **Unified Serverless Architecture (`api/index.js`)**: Unified dispatcher resolving Vercel's Hobby 12-function limit by cleanly routing all 14 backend modules through a single serverless endpoint.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Frontend** | Vanilla HTML5, CSS3, Modern JavaScript (ES6+ Single-Page App) |
| **Backend** | Node.js Serverless Functions (Vercel) & Standalone HTTP Server (`server.js`) |
| **Database** | MongoDB Atlas (`ca_office_workflow` database) |
| **Authentication** | JWT (JSON Web Tokens), `sessionStorage` session manager |
| **Biometrics** | `face-api.js` with neural network weights (`models/`) |
| **Cloud Integrations** | Google Drive API v3, Google Gemini / OpenAI (optional chat fallback) |

---

## Project Structure

```
.
├── api/                            # Serverless Backend
│   ├── index.js                    # Unified Dispatcher (bypasses Vercel Hobby 12-function ceiling)
│   └── _routes/                    # Modular Functional Route Handlers
│       ├── attendance.js           # Clock-in/out, OD status, daily & monthly attendance
│       ├── audit.js                # System security audit trail (partner-only view)
│       ├── auth.js                 # JWT verification, RBAC check, and audit logger helpers
│       ├── automate.js             # 1-click automated recurring GST task generation
│       ├── chat.js                 # Conversational AI workflow assistant
│       ├── clients.js              # Client master directory CRUD & search
│       ├── db.js                   # MongoDB Atlas connection manager
│       ├── drive.js                # Google Drive Service Account vault integration
│       ├── engagements.js          # Standard CA service types management
│       ├── init.js                 # First-run database initialisation and seeding
│       ├── login.js                # User authentication & JWT issuance
│       ├── recommend.js            # Algorithmic staff matching score calculator
│       ├── tasks.js                # Task workflow ledger CRUD, auto-healing & analytics
│       └── users.js                # Staff & Article user management
├── app.js                          # Core client-side application logic & DOM controller
├── biometrics.js                   # Web camera handler & face recognition pipeline
├── styles.css                      # Application styling & responsive layout
├── index.html                      # Single-page application shell
├── models/                         # Neural network weights for face detection & landmarks
├── server.js                       # Local development and standalone Node.js server
├── vercel.json                     # Vercel serverless URL rewrite rules
├── .env.example                    # Environment variable configuration template
├── package.json                    # Project dependencies and npm scripts
└── README.md                       # Complete system documentation
```

---

## Roles & Access Control

| Capability | Partner | Staff | Article |
|---|:---:|:---:|:---:|
| View Entire Office Ledger | &check; | Own tasks only | Own tasks only |
| Create / Allocate Tasks | &check; | &check; | &check; |
| Submit Tasks for Review | &check; | &check; | &check; |
| Approve / Reject Review Verdicts | &check; | &cross; | &cross; |
| Mark Task as Filed | &check; | &check; | &check; |
| Manage Clients | &check; | &check; | &check; |
| Manage User Accounts | &check; | &cross; | &cross; |
| View Security Audit Logs | &check; | &cross; | &cross; |
| View Office Attendance Logs | &check; | Own only | Own only |
| Batch Auto-Dispatch Compliance | &check; | &cross; | &cross; |

---

## Environment Configuration

Create a `.env` file in the root directory (or configure environment variables in your Vercel Dashboard):

```env
# MongoDB Atlas Connection URI
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster>.mongodb.net/ca_office_workflow?retryWrites=true&w=majority

# JWT Token Secret
JWT_SECRET=your_jwt_secret_key_here

# Local Server Port (Default: 3000)
PORT=3000

# Optional: External Generative AI Keys (for fallback natural language in chatbot)
GEMINI_API_KEY=
OPENAI_API_KEY=
```

A template is provided in [`.env.example`](./.env.example).

---

## Running Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Server
```bash
npm start
# Or execute directly:
node server.js
```
The application will be live at `http://localhost:3000`.

### 3. Initialize the Database
On a clean database, trigger first-time initialization to seed default service engagements and the default partner account:
```bash
curl http://localhost:3000/api/init
# Or visit http://localhost:3000/api/init in your browser
```

**Default Initial Partner Account:**
- **Username**: `smk`
- **Password**: `1234`
- **Role**: `partner`

---

## API Endpoints Reference

All API calls are dispatched through `/api/index.js` and require a `Bearer <token>` in the `Authorization` header (except `/api/login` and `/api/init`).

| Endpoint | Supported Methods | Description |
|---|---|---|
| `/api/login` | `POST` | Authenticates credentials and returns JWT token |
| `/api/tasks` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` | Task CRUD, status updates, auto-healing IDs, and analytics (`?mode=stats`) |
| `/api/clients` | `GET`, `POST`, `PUT`, `DELETE` | Client profiles CRUD with server-side pagination & regex search |
| `/api/users` | `GET`, `POST`, `PUT`, `DELETE` | User account management and facial descriptor storage |
| `/api/attendance` | `GET`, `POST`, `PUT` | Clock-in/out, OD status updates, daily list, and monthly summaries |
| `/api/chat` | `POST` | Conversational workflow assistant for queries, CRUD, and status transitions |
| `/api/automate` | `GET`, `POST` | Preview and batch auto-dispatch of recurring monthly GST filings |
| `/api/recommend` | `GET` | Computes top candidate staff matches for a given client and work type |
| `/api/drive` | `GET`, `POST` | Google Drive vault integration: status check, configuration, and file browsing |
| `/api/engagements` | `GET`, `POST`, `PUT`, `DELETE` | Standard CA service categories master list |
| `/api/audit` | `GET` | Paginated system action logs (Partner-only) |
| `/api/init` | `GET` | First-run setup: verifies and seeds standard partner user & engagements |

---

## Indian Compliance Standards Supported

- **PAN**: 10-digit alphanumeric (`ABCDE1234F`)
- **GSTIN**: 15-digit state-coded tax identification (`33ABCDE1234F1Z5`)
- **Aadhaar**: 12-digit UID (`XXXXXXXXXXXX`)
- **Assessment Years**: Indian financial year standards (`2026-27`, `2025-26`, `2024-25`)
- **Statutory GST Filings**: GSTR-1 (due 11th), GSTR-3B (due 20th), GSTR-4 (annual composition), CMP-08 (quarterly composition)
