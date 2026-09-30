#!/usr/bin/env node
/**
 * Print OAuth2 consent URL for mail (Gmail or Yandex).
 * Usage: node scripts/mail-oauth-url.cjs
 * Env: MAIL_PROVIDER, MAIL_OAUTH_CLIENT_ID, optional MAIL_OAUTH_REDIRECT_URI
 */
const provider = (process.env.MAIL_PROVIDER || "gmail").toLowerCase();
const clientId = process.env.MAIL_OAUTH_CLIENT_ID || "";
const redirect =
  process.env.MAIL_OAUTH_REDIRECT_URI || "http://localhost:8765/oauth/callback";

if (!clientId) {
  console.error("Set MAIL_OAUTH_CLIENT_ID (and create OAuth app in Google/Yandex).");
  process.exit(1);
}

if (provider === "yandex") {
  const scope = encodeURIComponent("mail:imap_full mail:smtp");
  const url =
    `https://oauth.yandex.ru/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&scope=${scope}`;
  console.log(url);
  console.log("\nAfter consent, exchange code → refresh_token at https://oauth.yandex.ru/token");
  console.log("Then set MAIL_AUTH_MODE=oauth2 MAIL_OAUTH_REFRESH_TOKEN=… MAIL_OAUTH_TOKEN_URL=https://oauth.yandex.ru/token");
} else {
  const scope = encodeURIComponent("https://mail.google.com/");
  const url =
    `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&access_type=offline&prompt=consent&scope=${scope}`;
  console.log(url);
  console.log("\nExchange code at https://oauth2.googleapis.com/token → MAIL_OAUTH_REFRESH_TOKEN");
  console.log("MAIL_AUTH_MODE=oauth2 MAIL_PROVIDER=gmail");
}
