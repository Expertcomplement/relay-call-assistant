# Relay

**A transparent AI phone assistant that makes routine calls and answers a connected number on your behalf.** Relay follows the task you give it, identifies itself as AI, and leaves decisions and commitments to you.

## Project links

- **Live app:** [relay-call-assistant.onrender.com](https://relay-call-assistant.onrender.com)
- **Source code:** [Expertcomplement/relay-call-assistant](https://github.com/Expertcomplement/relay-call-assistant)
- **Hackathon submission copy:** [HACKATHON_SUBMISSION.md](HACKATHON_SUBMISSION.md)

The hosted app is password protected. The public source does not contain provider credentials. Real calling becomes available after you connect a Vapi account and phone number.

## What it does

- Places a real outbound call from a phone number connected to Vapi.
- Answers inbound calls when an authenticated Vapi webhook and phone-number route are configured.
- Uses a per-call purpose, a clear AI disclosure, and a short, bounded conversation prompt.
- Shows call state and lets the signed-in owner end an active call.
- Provides a mobile-friendly, password-protected dashboard.

Relay does not pretend to be the account owner, make commitments, spend money, or continue if the recipient does not want to speak with an AI. It does not save call state, recordings, or transcripts in its own database. Vapi and phone provider retention and billing depend on your account settings.

## AI and phone providers

The default route uses **Vapi + Google Gemini + Deepgram + Vapi Voices** and does not require an OpenAI API key, OpenAI API calls, or the optional OpenAI packages. The model defaults to `gemini-2.5-flash`, transcription to Deepgram `nova-3`, and speech to the Vapi `Elliot` voice. These settings are sent as per-call overrides, so an assistant saved with a different model, transcriber, or voice still uses the configured non-OpenAI stack for Relay calls. Change the `VAPI_*` settings to use other compatible providers. Vapi's default Google integration or a connected Google account can be used. See [Gemini](https://docs.vapi.ai/providers/model/gemini), [Deepgram](https://docs.vapi.ai/providers/transcriber/deepgram), and [Vapi Voices](https://docs.vapi.ai/providers/voice/vapi-voices).

An optional legacy `openai_live` route remains for users with an OpenAI Live account and a compatible SIP trunk. It is not used in the default configuration. See [Vapi phone setup](https://docs.vapi.ai/phone-calling) and [Vapi outbound calling](https://docs.vapi.ai/calls/outbound-calling) for phone-number requirements. Vapi's free numbers support inbound calls only; outbound calls require an imported number. Phone, AI, and hosting charges may apply.

## Run locally

1. Install Node.js 20 or later.
2. Copy `.env.example` to `.env` and set a unique `APP_PASSWORD` and a random `SESSION_SECRET` of at least 32 characters.
3. Add `VAPI_API_KEY`, `VAPI_ASSISTANT_ID`, and `VAPI_PHONE_NUMBER_ID` from your Vapi account. Relay selects Google Gemini, Deepgram, and Vapi Voices per call by default.
4. Run `npm install` and `npm start`.
5. Open `http://127.0.0.1:3030` and sign in.

Keep `.env` private. Provider keys stay on the server and are never sent to the browser.

## Enable incoming calls

1. Deploy Relay at a public HTTPS address.
2. In Vapi, create a **Bearer Token** custom credential whose token matches `VAPI_WEBHOOK_SECRET`.
3. Set the phone number's Server URL to `https://YOUR_HOST/webhooks/vapi` and select that credential.
4. For Relay to assign the assistant dynamically, leave the phone number's assistant unassigned. Set `INBOUND_ENABLED=true` in Relay and restart it.
5. Assign an imported phone number to Relay. Vapi sends an `assistant-request`; Relay returns the saved assistant with the inbound AI-disclosure instructions. It also receives status updates for the call dashboard.

Do not enable inbound calls until the authenticated webhook and phone-number route are in place. Vapi expects the assistant-request response quickly, so host the app where it can respond reliably. A sleeping free host may miss or delay calls.

## Deploy on Render

This repo includes a `Dockerfile` for the Node web service. Connect the public GitHub repo to Render, choose the Docker runtime, and set these private environment variables:

```text
NODE_ENV=production
HOST=0.0.0.0
APP_PASSWORD=<a private sign-in password>
SESSION_SECRET=<a random value with at least 32 characters>
VAPI_API_KEY=<your Vapi private key>
VAPI_ASSISTANT_ID=<your Vapi assistant ID>
VAPI_PHONE_NUMBER_ID=<your imported phone number ID>
VAPI_MODEL_PROVIDER=google
VAPI_MODEL=gemini-2.5-flash
VAPI_TRANSCRIBER_PROVIDER=deepgram
VAPI_TRANSCRIBER_MODEL=nova-3
VAPI_VOICE_PROVIDER=vapi
VAPI_VOICE_ID=Elliot
VAPI_VOICE_VERSION=2
INBOUND_ENABLED=false
```

Add `VAPI_WEBHOOK_SECRET` and set `INBOUND_ENABLED=true` only after completing the inbound setup above. Never place API keys, phone credentials, or the app password in source control. Render's free web services can sleep while idle, which is unsuitable for reliable inbound-call answering; use an always-on plan for that use.

## Optional OpenAI Live provider

Set `VOICE_PROVIDER=openai_live`, configure `OPENAI_API_KEY` and the SIP trunk variables in `.env.example`, and follow the OpenAI Live webhook/SIP setup for that account. The Vapi settings are ignored in this mode. The default `VOICE_PROVIDER=vapi` path does not call OpenAI.

## Privacy and safe use

- The sign-in cookie is HTTP-only, SameSite strict, and secure in production; login attempts are rate limited.
- Call requests require confirmation, international-format phone numbers, one call at a time, and a 30-second spacing limit.
- The assistant discloses that it is AI, sticks to the stated purpose, and will not commit the owner to actions.
- Relay itself does not store transcripts or recordings. Check provider retention settings before use; provider dashboards may retain call artifacts depending on configuration.
- Use only numbers you are authorized to call. Follow the consent, AI-disclosure, caller-ID, telemarketing, and recording rules where the caller and recipient are located.

## Implementation notes

- Node.js, Express, `express-session`, and WebSocket support for the optional OpenAI Live adapter.
- Vapi REST API for calls, call-control URLs, and authenticated server events.
- In-memory active-call state; it resets when the app restarts and is not shared across multiple service instances.
- No billing, CRM, scheduling, or autonomous commitment actions are enabled.
