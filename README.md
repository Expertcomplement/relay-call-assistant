# Relay call assistant

Relay places real phone calls through an OpenAI Live session and a SIP trunk provider. It can also answer incoming calls after an OpenAI Live webhook and inbound SIP route are configured. The assistant identifies itself as AI and does not impersonate the account owner. Calls are not recorded by this app.

## Start the app

1. Install Node.js 20 or later.
2. In this folder, copy `.env.example` to `.env`, set a private `APP_PASSWORD`, generate a random `SESSION_SECRET` with at least 32 characters, and fill in the OpenAI API key and SIP trunk details. Keep `.env` private; do not commit it or paste secrets into chat.
3. Run `npm install`, then `npm start`.
4. Open `http://127.0.0.1:3030`.

The app binds to localhost for local use. API keys and SIP credentials stay in the server environment. The sign-in cookie is HTTP-only and SameSite strict; login attempts are rate-limited. Outgoing calls require explicit confirmation, validate international phone numbers, and are rate-limited.

## Host it for phone access

Deploy the included `Dockerfile` to an always-on Node/Docker web service with HTTPS. Set `HOST=0.0.0.0`, `NODE_ENV=production`, `APP_PASSWORD`, a unique `SESSION_SECRET` (at least 32 characters), `OPENAI_API_KEY`, and the SIP settings as private service variables. Do not make a static-only deployment; the Node server handles sign-in, real call requests, and the OpenAI webhook. After the host provides the HTTPS URL, open it on your phone and sign in with `APP_PASSWORD`.

An always-on service is needed for reliable incoming-call answering. Hosting and phone/SIP provider charges may apply. No hosting account or cloud secrets are included in this source package.

## SIP setup

Use a provider and number that support SIP Digest, TLS signaling, and SDES-SRTP. Configure `SIP_PROVIDER_URL` with the provider's `sips:` endpoint, plus its SIP username and password. Set `SIP_CALLER_NUMBER` to a number that the provider authorizes for caller ID. Confirm the provider permits the countries and destinations you plan to call.

## Enable incoming calls

1. Deploy this Node app to a public HTTPS host. Keep `OPENAI_API_KEY` and SIP credentials as server-side secrets. Configure the deployment and firewall to allow the provider's SIP/TLS and SRTP traffic.
2. In the OpenAI API project, create a webhook subscribed to `live.transport.incoming`, pointing to `https://YOUR_HOST/webhooks/openai`. Copy its signing secret into `OPENAI_WEBHOOK_SECRET`.
3. Route the SIP trunk's incoming calls to `sip:YOUR_OPENAI_PROJECT_ID@sip.api.openai.com;transport=tls` and allow SRTP in the trunk settings.
4. Set `INBOUND_ENABLED=true` and redeploy/restart.

Until all four steps are complete, incoming call answering remains off. The webhook verifies OpenAI's signature before accepting or rejecting calls.

## Notes

- A successful session creation means the provider has received the call request; the result can still be ringing or fail later. The dashboard follows call state while the app is running.
- This initial version keeps call state in memory only and does not save transcripts or recordings.
- For a public multi-user deployment, add account sign-in and per-user authorization before exposing call controls. This starter deliberately binds its controls to localhost.
- Confirm applicable consent, caller identification, telemarketing, and recording rules for the countries involved.

## Technical flow

The backend creates `POST /v1/live/sessions` requests for outgoing calls and attaches a sideband WebSocket for progress and hang-up controls. Incoming Live webhooks are signature checked and accepted only when `INBOUND_ENABLED=true`. OpenAI's Live API handles the real-time spoken conversation; the SIP provider handles the phone network.
