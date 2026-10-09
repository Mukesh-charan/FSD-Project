
const fs = require("fs");
const http = require("http");
const { google } = require("googleapis");

const config = JSON.parse(
  fs.readFileSync("oauth-credentials.json", "utf8")
);

const client = config.web;
const redirectUri = "http://localhost:3000/oauth2callback";

const oauth = new google.auth.OAuth2(
  client.client_id,
  client.client_secret,
  redirectUri
);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, redirectUri);

  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404).end("Not found");
    return;
  }

  try {
    if (url.searchParams.get("error")) {
      throw new Error(url.searchParams.get("error"));
    }

    const code = url.searchParams.get("code");
    if (!code) throw new Error("Missing authorization code");

    const { tokens } = await oauth.getToken(code);

    if (!tokens.refresh_token) {
      throw new Error(
        "No refresh token returned. Revoke this app's existing Google access and authorize again."
      );
    }

    // Verify the token can access your existing folder.
    oauth.setCredentials(tokens);
    const drive = google.drive({ version: "v3", auth: oauth });

    const folder = await drive.files.get({
      fileId: "1uQnyR7B6v0cNAZ4GzaqErktO0AgcQqju",
      fields: "id,name,mimeType",
    });

    console.log("Authorized folder:", folder.data.name);
    console.log("\nRefresh token (keep secret):\n");
    console.log(tokens.refresh_token);

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Google Drive authorization successful. You can close this tab.");
    server.close();
  } catch (err) {
    console.error("Authorization failed:", err.message);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Authorization failed. Check your terminal.");
    server.close();
  }
});

server.listen(3000, "127.0.0.1", () => {
  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: ["https://www.googleapis.com/auth/drive"],
  });

  console.log("Open this URL in your browser:\n");
  console.log(authUrl);
});
